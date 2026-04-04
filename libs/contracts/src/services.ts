/** Logical service names. Used as event `producer`, inbox consumer names and log fields. */
export const ServiceName = {
  order: 'order-service',
  inventory: 'inventory-service',
  payment: 'payment-service',
  notification: 'notification-service',
} as const;
export type ServiceName = (typeof ServiceName)[keyof typeof ServiceName];
