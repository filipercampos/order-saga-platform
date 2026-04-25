import './tracing';
import { runService } from '@saga/platform';
import { shutdownTracing } from '@saga/tracing';
import { loadOrderEnv } from './config';
import { OrderModule } from './order.module';

const env = loadOrderEnv();
runService(OrderModule.forRoot(env), env.PORT).catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
process.once('SIGTERM', () => void shutdownTracing());
