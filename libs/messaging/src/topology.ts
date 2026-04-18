/**
 * Messaging topology as data: the single source of truth for local provisioning
 * (LocalStack, integration tests) and the reference for infra/messaging.yaml.
 * See ADR 0003 for the reasoning behind FIFO, visibility timeouts and receive counts.
 */
export const Topics = {
  sagaCommands: 'saga-commands.fifo',
  orderEvents: 'order-events',
  inventoryEvents: 'inventory-events',
  paymentEvents: 'payment-events',
} as const;
export type TopicName = (typeof Topics)[keyof typeof Topics];

export const Queues = {
  inventoryCommands: 'inventory-commands.fifo',
  paymentCommands: 'payment-commands.fifo',
  orderSagaReplies: 'order-saga-replies',
  orderHistory: 'order-history',
  notificationOrderEvents: 'notification-order-events',
} as const;
export type QueueName = (typeof Queues)[keyof typeof Queues];

export interface SubscriptionSpec {
  topic: TopicName;
  /** SNS filter policy on message attributes (exact-match lists only). */
  filterPolicy?: Record<string, string[]>;
}

export interface QueueSpec {
  name: QueueName;
  visibilityTimeoutSeconds: number;
  maxReceiveCount: number;
  subscriptions: SubscriptionSpec[];
}

export interface Topology {
  topics: TopicName[];
  queues: QueueSpec[];
}

export const isFifo = (name: string): boolean => name.endsWith('.fifo');

export function dlqNameOf(queue: string): string {
  return isFifo(queue) ? queue.replace(/\.fifo$/, '-dlq.fifo') : `${queue}-dlq`;
}

/** Physical names are prefixed per environment: `saga-dev-order-events`. */
export function physicalName(namespace: string, logical: string): string {
  return `${namespace}-${logical}`;
}

export type QueueOverrides = Partial<
  Record<QueueName, Partial<Pick<QueueSpec, 'visibilityTimeoutSeconds' | 'maxReceiveCount'>>>
>;

export function defaultTopology(overrides: QueueOverrides = {}): Topology {
  const queues: QueueSpec[] = [
    {
      name: Queues.inventoryCommands,
      visibilityTimeoutSeconds: 30,
      maxReceiveCount: 5,
      subscriptions: [{ topic: Topics.sagaCommands, filterPolicy: { target: ['inventory'] } }],
    },
    {
      // The ledger client can spend ~8 s on retries; 60 s keeps one in-flight owner.
      name: Queues.paymentCommands,
      visibilityTimeoutSeconds: 60,
      maxReceiveCount: 5,
      subscriptions: [{ topic: Topics.sagaCommands, filterPolicy: { target: ['payment'] } }],
    },
    {
      name: Queues.orderSagaReplies,
      visibilityTimeoutSeconds: 30,
      maxReceiveCount: 10,
      subscriptions: [{ topic: Topics.inventoryEvents }, { topic: Topics.paymentEvents }],
    },
    {
      name: Queues.orderHistory,
      visibilityTimeoutSeconds: 30,
      maxReceiveCount: 10,
      subscriptions: [
        { topic: Topics.orderEvents },
        { topic: Topics.inventoryEvents },
        { topic: Topics.paymentEvents },
      ],
    },
    {
      name: Queues.notificationOrderEvents,
      visibilityTimeoutSeconds: 60,
      maxReceiveCount: 5,
      subscriptions: [
        {
          topic: Topics.orderEvents,
          filterPolicy: { type: ['order.OrderConfirmed', 'order.OrderCancelled'] },
        },
      ],
    },
  ];
  return {
    topics: Object.values(Topics),
    queues: queues.map((queue) => ({ ...queue, ...overrides[queue.name] })),
  };
}
