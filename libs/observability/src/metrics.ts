/**
 * CloudWatch Embedded Metric Format. One JSON line per data point on stdout; Fluent Bit
 * ships it to CloudWatch Logs, which extracts the metric. No PutMetricData calls on the
 * hot path, and the same line is a searchable log event.
 */
export const METRIC_NAMESPACE = 'OrderSaga';

export type Unit = 'Count' | 'Seconds' | 'Milliseconds';

export type MetricWriter = (line: string) => void;

const stdoutWriter: MetricWriter = (line) => process.stdout.write(`${line}\n`);

export class Metrics {
  constructor(
    private readonly service: string,
    private readonly write: MetricWriter = stdoutWriter,
    private readonly enabled = true,
  ) {}

  count(name: string, value = 1, dimensions: Record<string, string> = {}): void {
    this.emit(name, value, 'Count', dimensions);
  }

  duration(name: string, ms: number, dimensions: Record<string, string> = {}): void {
    this.emit(name, ms, 'Milliseconds', dimensions);
  }

  gauge(name: string, value: number, unit: Unit, dimensions: Record<string, string> = {}): void {
    this.emit(name, value, unit, dimensions);
  }

  private emit(name: string, value: number, unit: Unit, dimensions: Record<string, string>) {
    if (!this.enabled) return;
    const dims = { Service: this.service, ...dimensions };
    this.write(
      JSON.stringify({
        _aws: {
          Timestamp: Date.now(),
          CloudWatchMetrics: [
            {
              Namespace: METRIC_NAMESPACE,
              Dimensions: [Object.keys(dims)],
              Metrics: [{ Name: name, Unit: unit }],
            },
          ],
        },
        ...dims,
        [name]: value,
      }),
    );
  }
}
