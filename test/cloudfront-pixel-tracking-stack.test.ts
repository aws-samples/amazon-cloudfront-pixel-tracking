import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { CloudFrontPixelTrackingStack } from '../lib/cloudfront-pixel-tracking-stack';

test('S3 Created', () => {
  const app = new cdk.App();
    // WHEN
  const stack = new CloudFrontPixelTrackingStack(app, 'MyTestStack');
  
    // THEN
  const template = Template.fromStack(stack);
  template.resourceCountIs('AWS::S3::Bucket', 3);
});
