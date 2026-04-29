import './tracing';
import { runService } from '@saga/platform';
import { shutdownTracing } from '@saga/tracing';
import { loadInventoryEnv } from './config';
import { InventoryModule } from './inventory.module';

const env = loadInventoryEnv();
runService(InventoryModule.forRoot(env), env.PORT).catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
process.once('SIGTERM', () => void shutdownTracing());
