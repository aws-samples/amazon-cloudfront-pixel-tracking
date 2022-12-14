#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CloudFrontPixelTrackingStack } from '../lib/cloudfront-pixel-tracking-stack';

const app = new cdk.App();
new CloudFrontPixelTrackingStack(app, 'CloudFrontPixelTrackingStack');

