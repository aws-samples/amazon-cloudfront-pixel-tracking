import {
  Aws,
  CfnOutput,
  RemovalPolicy,
  Stack,
  StackProps,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';

import * as kinesis from 'aws-cdk-lib/aws-kinesis';
import * as firehose from '@aws-cdk/aws-kinesisfirehose-alpha';
import * as firehose_destinations from '@aws-cdk/aws-kinesisfirehose-destinations-alpha';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as glue_alpha from '@aws-cdk/aws-glue-alpha';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Key } from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';

export class CloudFrontPixelTrackingStack extends Stack {
  public readonly kinesisDataFireHoseArn: string;
  public readonly loggingBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const loggingBucket = new s3.Bucket(this, 'pixel-tracking-logging-bucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      enforceSSL: true,
      accessControl: s3.BucketAccessControl.LOG_DELIVERY_WRITE,
    });

    // Kinesis stream output bucket creating a data lake
    const dataLake = new s3.Bucket(this, 'pixel-tracking-data-lake', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      enforceSSL: true,
      serverAccessLogsBucket: loggingBucket,
      serverAccessLogsPrefix: 's3-data-stream-access-logs',
    });

    // S3 data output prefix properties
    const s3Destination = new firehose_destinations.S3Bucket(dataLake, {
      dataOutputPrefix: 'year=!{timestamp:YYYY}/month=!{timestamp:MM}/day=!{timestamp:dd}/hour=!{timestamp:HH}/',
      errorOutputPrefix: 'fherroroutputbase/!{firehose:random-string}/!{firehose:error-output-type}/!{timestamp:yyyy/MM/dd}/',
    });

    // Real-time logs written to Kinesis Data Stream
    const dataStream = new kinesis.Stream(this, 
      'pixel-tracking-data-stream', {
        encryption: kinesis.StreamEncryption.MANAGED,
        streamMode: kinesis.StreamMode.ON_DEMAND,
      }
    );

    // A delivery stream can read directly from a Kinesis Data Stream
    new firehose.DeliveryStream(this, 
      'pixel-tracking-delivery-stream', {
        sourceStream: dataStream,
        destinations: [s3Destination],
      }
    );

    const glueDatabase = new glue_alpha.Database(this, 
      'pixel-tracking-database', {
        databaseName: 'pixel_tracking_db',
      }
    );

    // create a KMS key used for data encryption by Glue security configuration
    const glueKey =  new Key(this, 'pixel-tracking-data-encryption-kms-key', {
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    glueKey.addToResourcePolicy(new iam.PolicyStatement({
      principals: [
        new iam.ServicePrincipal(`logs.${Aws.REGION}.amazonaws.com`)
      ],
      actions: [
        'kms:Encrypt*',
        'kms:Decrypt*',
        'kms:ReEncrypt*',
        'kms:GenerateDataKey*',
        'kms:Describe*'
      ],
      resources: ['*'],
      conditions: { 
        ArnLike: { 
          'kms:EncryptionContext:aws:logs:arn': `arn:aws:logs:${Aws.REGION}:${Aws.ACCOUNT_ID}:*` 
        }
      },
    }));

    // Glue needs access to the following to use KMS, S3, and Glue services
    const glueRole = new iam.Role(this, 'PixelDataProcessingGlueRole', {
      assumedBy: new iam.ServicePrincipal('glue.amazonaws.com'),
      // add inline policy to encrypt logs
      inlinePolicies: {
        SecurityConfig: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: [
                'logs:AssociateKmsKey'
              ],
              resources: [
                `arn:aws:logs:${Aws.REGION}:${Aws.ACCOUNT_ID}:log-group:/aws-glue/crawlers-role/*`
              ],
            })
          ]
        })
      }
    });

    glueRole.addToPolicy(new iam.PolicyStatement({
      resources: [glueKey.keyArn],
      actions: [
        'kms:GenerateDataKey',
        'kms:Decrypt',
        'kms:Encrypt',
      ],
    }));

    glueRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName(
        'service-role/AWSGlueServiceRole'
      )
    );

    dataLake.grantRead(glueRole);

    // Security configuration is used to encrypt data at rest for glue
    const glueSecurityOptions = new glue_alpha.SecurityConfiguration(this, 
      'pixel-tracking-glue-security-configuration', {
        cloudWatchEncryption: {
          mode: glue_alpha.CloudWatchEncryptionMode.KMS,
          kmsKey: glueKey,
        },
        jobBookmarksEncryption: {
          mode: glue_alpha.JobBookmarksEncryptionMode.CLIENT_SIDE_KMS,
          kmsKey: glueKey,
        },
        s3Encryption: {
          mode: glue_alpha.S3EncryptionMode.S3_MANAGED,
        }
      }
    );

    // Use Glue crawler to automatically create schema tables
    new glue.CfnCrawler(this, 'pixel-tracking-glue-crawler', {
      role: glueRole.roleName,
      targets: {
        s3Targets: [{
          path: `S3://${dataLake.bucketName}`,
        }],
      },
      databaseName: glueDatabase.databaseName,
      description: 'Glue crawler for pixel tracking data',
      crawlerSecurityConfiguration: glueSecurityOptions.securityConfigurationName,
      recrawlPolicy: {
        recrawlBehavior: 'CRAWL_EVERYTHING',
      },
      schedule: {
        scheduleExpression: 'cron(40 * * * ? *)',
      },
      tablePrefix: 'pt_',
    });

    // HTML webpage
    const bucket = new s3.Bucket(this, 'pixel-tracking-webpage-bucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      enforceSSL: true,
      serverAccessLogsBucket: loggingBucket,
      serverAccessLogsPrefix: 's3-web-page-access-logs',
    });

    // Cloudfront Distribution for webpage, pixel image, and real-time logs 
    const distribution = new cloudfront.Distribution(this, 
      'pixel-tracking-distribution', {
        comment: 'Pixel Tracking Distribution',
        defaultRootObject: 'index.html',
        defaultBehavior: {
          origin: new origins.S3Origin(bucket),
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        },
        logBucket: loggingBucket,
        logFilePrefix: 'cloudfront-access-logs',
      }
    );

    // Creating role for CloudFront to put records into Kinesis stream
    const pixelProcessingCloudFrontRole = new iam.Role(this, 
      'PixelProcessingCloudFrontRole', {
        assumedBy: new iam.CompositePrincipal(
          new iam.ServicePrincipal('cloudfront.amazonaws.com'),
          new iam.AccountPrincipal(this.account)
        ),
      }
    );
    pixelProcessingCloudFrontRole.addToPolicy(new iam.PolicyStatement({
      resources: [dataStream.streamArn],
      actions: [
        'kinesis:DescribeStreamSummary',
        'kinesis:DescribeStream',
        'kinesis:PutRecord', 
        'kinesis:PutRecords',
      ],
    }));

    const cfnRealtimeLogConfig = new cloudfront.CfnRealtimeLogConfig(this, 
      'pixel-tracking-real-time-log-config', {
        endPoints: [{
          kinesisStreamConfig: {
            roleArn: pixelProcessingCloudFrontRole.roleArn,
            streamArn: dataStream.streamArn,
          },
          streamType: 'Kinesis',
        }],
        fields: [
          'timestamp',
          'c-ip',
          'cs-user-agent',
          'cs-uri-query',
        ],
        name: `cloudfront-real-time-log-config-${this.stackName}`,
        samplingRate: 100,
      }
    );

    // Real-time logs aren't directly supported by the new API, so use escape hatches
    const cfnDistribution = distribution.node.defaultChild as cloudfront.CfnDistribution;

    cfnDistribution.addPropertyOverride(
      'DistributionConfig.DefaultCacheBehavior.RealtimeLogConfigArn', cfnRealtimeLogConfig.attrArn
    );

    new s3deploy.BucketDeployment(this, 'pixel-tracking-deploy-webpage', {
      sources: [s3deploy.Source.asset('./webpage')],
      destinationBucket: bucket,
      distribution: distribution,
      distributionPaths: ['/*'],
    });

    new CfnOutput(this, 'cloudFrontUrl', { 
      value: distribution.distributionDomainName 
    });    
  }
}
