import './tracing';
import { runService } from '@saga/platform';
import { shutdownTracing } from '@saga/tracing';
import { loadPaymentEnv } from './config';
import { PaymentModule } from './payment.module';

const env = loadPaymentEnv();
runService(PaymentModule.forRoot(env), env.PORT).catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
process.once('SIGTERM', () => void shutdownTracing());
