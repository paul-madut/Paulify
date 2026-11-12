import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as cdk from 'aws-cdk-lib';
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';

export class PaulifyStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const publicKeyPem = this.resolvePublicKey();

    // ---------------------------------------------------------------------
    // Audio origin: private bucket, reachable only through CloudFront.
    // ---------------------------------------------------------------------
    const bucket = new s3.Bucket(this, 'AudioBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      enforceSSL: true,
      lifecycleRules: [
        {
          id: 'abort-incomplete-uploads',
          abortIncompleteMultipartUploadAfter: Duration.days(7),
          noncurrentVersionExpiration: Duration.days(30),
        },
      ],
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // ---------------------------------------------------------------------
    // Catalogue: single table, on-demand, two GSIs.
    // ---------------------------------------------------------------------
    const table = new dynamodb.Table(this, 'Catalog', {
      tableName: 'paulify-catalog',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // Everything by one artist, newest first.
    table.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: { name: 'gsi1pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'gsi1sk', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // The whole library as one title-ordered partition, so title prefix search is a key condition.
    table.addGlobalSecondaryIndex({
      indexName: 'GSI2',
      partitionKey: { name: 'gsi2pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'gsi2sk', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ---------------------------------------------------------------------
    // Signing key: private half in Secrets Manager, public half on the distribution.
    // ---------------------------------------------------------------------
    const signingSecret = new secretsmanager.Secret(this, 'SigningKey', {
      secretName: 'paulify/cloudfront-private-key',
      description: 'Private key for signing Paulify CloudFront playback URLs',
    });

    const publicKey = new cloudfront.PublicKey(this, 'SigningPublicKey', {
      encodedKey: publicKeyPem,
      comment: 'Paulify playback URL signing',
    });

    const keyGroup = new cloudfront.KeyGroup(this, 'SigningKeyGroup', {
      items: [publicKey],
      comment: 'Signs Paulify playback URLs',
    });

    // Audio never changes once written, so it can be cached hard at the edge.
    const audioCachePolicy = new cloudfront.CachePolicy(this, 'AudioCachePolicy', {
      cachePolicyName: 'paulify-audio',
      minTtl: Duration.seconds(0),
      defaultTtl: Duration.days(30),
      maxTtl: Duration.days(365),
      enableAcceptEncodingGzip: false,
      enableAcceptEncodingBrotli: false,
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
    });

    const distribution = new cloudfront.Distribution(this, 'AudioCdn', {
      comment: 'Paulify audio',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
        cachePolicy: audioCachePolicy,
        trustedKeyGroups: [keyGroup],
        compress: false,
      },
    });

    // ---------------------------------------------------------------------
    // Read path
    // ---------------------------------------------------------------------
    const commonEnvironment = {
      TABLE_NAME: table.tableName,
      BUCKET_NAME: bucket.bucketName,
      DISTRIBUTION_DOMAIN: distribution.distributionDomainName,
      KEY_PAIR_ID: publicKey.publicKeyId,
      PRIVATE_KEY_SECRET_ARN: signingSecret.secretArn,
      NODE_OPTIONS: '--enable-source-maps',
    };

    const bundling = {
      externalModules: ['@aws-sdk/*'],
      minify: true,
      sourceMap: true,
      target: 'node22',
    };

    const listTracks = new NodejsFunction(this, 'ListTracks', {
      entry: join(__dirname, '..', 'api', 'handlers', 'list-tracks.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: Duration.seconds(10),
      memorySize: 256,
      environment: commonEnvironment,
      bundling,
    });

    const playTrack = new NodejsFunction(this, 'PlayTrack', {
      entry: join(__dirname, '..', 'api', 'handlers', 'play-track.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: Duration.seconds(10),
      memorySize: 256,
      environment: commonEnvironment,
      bundling,
    });

    // Least privilege: read-only on the catalogue, object read for the existence
    // check, and read on the one signing secret.
    table.grantReadData(listTracks);
    table.grantReadData(playTrack);
    bucket.grantRead(playTrack, 'audio/*');
    signingSecret.grantRead(playTrack);

    const api = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: 'paulify-api',
      createDefaultStage: false,
    });

    // One stage with explicit throttling, so a misbehaving client cannot hammer
    // the read path and run up Lambda spend.
    new apigwv2.HttpStage(this, 'DefaultStage', {
      httpApi: api,
      stageName: '$default',
      autoDeploy: true,
      throttle: { rateLimit: 10, burstLimit: 20 },
    });

    api.addRoutes({
      path: '/tracks',
      methods: [apigwv2.HttpMethod.GET],
      integration: new HttpLambdaIntegration('ListTracksIntegration', listTracks),
    });

    api.addRoutes({
      path: '/tracks/{id}/play',
      methods: [apigwv2.HttpMethod.GET],
      integration: new HttpLambdaIntegration('PlayTrackIntegration', playTrack),
    });

    // ---------------------------------------------------------------------
    // Operations
    // ---------------------------------------------------------------------
    const alarms: cloudwatch.Alarm[] = [
      new cloudwatch.Alarm(this, 'Api5xx', {
        alarmDescription: 'Paulify API is returning 5xx responses',
        metric: api.metricServerError({ period: Duration.minutes(5) }),
        threshold: 5,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
      new cloudwatch.Alarm(this, 'PlayTrackErrors', {
        alarmDescription: 'PlayTrack Lambda is throwing',
        metric: playTrack.metricErrors({ period: Duration.minutes(5) }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    ];

    const alarmEmail = this.node.tryGetContext('alarmEmail');
    if (alarmEmail) {
      const topic = new sns.Topic(this, 'AlarmTopic', { displayName: 'Paulify alarms' });
      topic.addSubscription(new subscriptions.EmailSubscription(String(alarmEmail)));
      for (const alarm of alarms) {
        alarm.addAlarmAction(new actions.SnsAction(topic));
      }
    }

    // ---------------------------------------------------------------------
    // Cost guardrail. A CDN mistake bills by the gigabyte, so the ceiling is
    // low and loud rather than discovered at the end of the month.
    // ---------------------------------------------------------------------
    new budgets.CfnBudget(this, 'MonthlyBudget', {
      budget: {
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: 5, unit: 'USD' },
      },
      notificationsWithSubscribers: alarmEmail
        ? [
            {
              notification: {
                notificationType: 'ACTUAL',
                comparisonOperator: 'GREATER_THAN',
                threshold: 80,
                thresholdType: 'PERCENTAGE',
              },
              subscribers: [{ subscriptionType: 'EMAIL', address: String(alarmEmail) }],
            },
          ]
        : [],
    });

    new cdk.CfnOutput(this, 'ApiUrl', { value: api.apiEndpoint });
    new cdk.CfnOutput(this, 'DistributionDomain', {
      value: distribution.distributionDomainName,
    });
    new cdk.CfnOutput(this, 'BucketName', { value: bucket.bucketName });
    new cdk.CfnOutput(this, 'TableName', { value: table.tableName });
    new cdk.CfnOutput(this, 'SigningSecretArn', { value: signingSecret.secretArn });
    new cdk.CfnOutput(this, 'SigningPublicKeyId', { value: publicKey.publicKeyId });
  }

  /**
   * The public half of the CloudFront signing pair.
   * Taken from CDK context when present, otherwise from `npm run keys` output.
   */
  private resolvePublicKey(): string {
    const fromContext = this.node.tryGetContext('cloudFrontPublicKey');
    if (typeof fromContext === 'string' && fromContext.includes('BEGIN PUBLIC KEY')) {
      return fromContext;
    }

    const keyPath = join(__dirname, 'keys', 'cloudfront_public_key.pem');
    if (existsSync(keyPath)) return readFileSync(keyPath, 'utf8');

    throw new Error(
      'CloudFront public key not found. Run `npm run keys` to generate infra/keys/, ' +
        'or pass -c cloudFrontPublicKey="$(cat path/to/public_key.pem)".',
    );
  }
}
