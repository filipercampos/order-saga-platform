import { SNSClient } from '@aws-sdk/client-sns';
import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { physicalName } from './topology';

export interface AwsMessagingConfig {
  region: string;
  /** LocalStack endpoint locally; unset in AWS. */
  endpoint?: string;
  accountId: string;
  namespace: string;
}

export interface AwsClients {
  sns: SNSClient;
  sqs: SQSClient;
}

export function createAwsClients(
  config: Pick<AwsMessagingConfig, 'region' | 'endpoint'>,
): AwsClients {
  const common = {
    region: config.region,
    endpoint: config.endpoint,
    // LocalStack (endpoint set) accepts any static key; in AWS the default provider chain
    // resolves IRSA web-identity credentials for the pod's service account.
    ...(config.endpoint
      ? {
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
          },
        }
      : {}),
  };
  return { sns: new SNSClient(common), sqs: new SQSClient(common) };
}

/** Resolves logical topic/queue names to ARNs and URLs for one environment. */
export class MessagingAddresses {
  private readonly queueUrls = new Map<string, Promise<string>>();

  constructor(
    private readonly config: AwsMessagingConfig,
    private readonly sqs: SQSClient,
  ) {}

  topicArn(logical: string): string {
    const { region, accountId, namespace } = this.config;
    return `arn:aws:sns:${region}:${accountId}:${physicalName(namespace, logical)}`;
  }

  queueUrl(logical: string): Promise<string> {
    let url = this.queueUrls.get(logical);
    if (!url) {
      url = this.sqs
        .send(new GetQueueUrlCommand({ QueueName: physicalName(this.config.namespace, logical) }))
        .then((out) => {
          if (!out.QueueUrl) throw new Error(`queue ${logical} not found`);
          return out.QueueUrl;
        });
      // Do not cache failures (queue may be provisioned later).
      url.catch(() => this.queueUrls.delete(logical));
      this.queueUrls.set(logical, url);
    }
    return url;
  }
}
