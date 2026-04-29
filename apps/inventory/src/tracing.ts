// Imported first by main.ts so instrumentation hooks are installed before anything else loads.
import { startTracing } from '@saga/tracing';

startTracing('inventory-service');
