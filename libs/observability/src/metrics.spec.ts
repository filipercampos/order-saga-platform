import { Metrics } from './metrics';

describe('Metrics (EMF)', () => {
  it('writes one EMF document per data point with the service dimension', () => {
    const lines: string[] = [];
    new Metrics('order-service', (line) => lines.push(line)).count('SagaTransition', 1, {
      To: 'CONFIRMED',
    });
    const doc = JSON.parse(lines[0] ?? '{}');
    expect(doc).toMatchObject({
      Service: 'order-service',
      To: 'CONFIRMED',
      SagaTransition: 1,
      _aws: {
        CloudWatchMetrics: [
          {
            Namespace: 'OrderSaga',
            Dimensions: [['Service', 'To']],
            Metrics: [{ Name: 'SagaTransition', Unit: 'Count' }],
          },
        ],
      },
    });
  });

  it('can be disabled (tests, local runs)', () => {
    const lines: string[] = [];
    new Metrics('x', (line) => lines.push(line), false).count('Anything');
    expect(lines).toEqual([]);
  });
});
