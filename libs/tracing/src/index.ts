import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK } from '@opentelemetry/sdk-node';

/**
 * OpenTelemetry must start before instrumented modules (http, express, pg, aws-sdk) are
 * required, so this lib has no other dependencies and is the first import of every
 * main.ts. On EKS the exporter targets the ADOT collector (DaemonSet on the EC2 node
 * group, sidecar on Fargate), which forwards to X-Ray.
 */
let sdk: NodeSDK | undefined;

export function startTracing(serviceName: string): void {
  if (sdk || !process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return;
  sdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME ?? serviceName,
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
        '@opentelemetry/instrumentation-net': { enabled: false },
      }),
    ],
  });
  sdk.start();
}

export async function shutdownTracing(): Promise<void> {
  await sdk?.shutdown();
}
