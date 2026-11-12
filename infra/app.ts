import * as cdk from 'aws-cdk-lib';
import { PaulifyStack } from './paulify-stack';

const app = new cdk.App();

new PaulifyStack(app, 'PaulifyStack', {
  description: 'Paulify music streaming: audio CDN, catalogue, and read API',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    // Ottawa first: the client and its owner are in Canada.
    region: process.env.CDK_DEFAULT_REGION ?? 'ca-central-1',
  },
});

app.synth();
