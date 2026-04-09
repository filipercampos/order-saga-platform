import { randomUUID } from 'node:crypto';
import { createEnvelope } from './envelope';
import { InvalidMessageError, isType, parseEnvelope } from './parse';

describe('parseEnvelope', () => {
  const orderId = randomUUID();

  it('round-trips a valid command', () => {
    const envelope = createEnvelope({
      type: 'inventory.ReserveStock',
      payload: { orderId, items: [{ sku: 'SKU-1', quantity: 2 }] },
      producer: 'order-service',
      correlationId: orderId,
    });
    const parsed = parseEnvelope(JSON.stringify(envelope));
    expect(parsed).toEqual(envelope);
    expect(isType(parsed, 'inventory.ReserveStock')).toBe(true);
  });

  it.each([
    ['not json', 'body is not valid JSON'],
    [JSON.stringify({ hello: 'world' }), 'invalid envelope'],
    [
      JSON.stringify(
        createEnvelope({ type: 'unknown.Thing', payload: {}, producer: 'x', correlationId: 'y' }),
      ),
      'unknown message type',
    ],
    [
      JSON.stringify(
        createEnvelope({
          type: 'payment.ChargePayment',
          payload: { orderId, customerId: 'c', amount: '-5', currency: 'BRL' },
          producer: 'x',
          correlationId: orderId,
        }),
      ),
      'invalid payment.ChargePayment payload at amount',
    ],
  ])('rejects %s as poison', (body, message) => {
    expect(() => parseEnvelope(body)).toThrow(InvalidMessageError);
    expect(() => parseEnvelope(body)).toThrow(message);
  });
});
