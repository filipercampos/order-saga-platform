import './tracing';
import { runService } from '@saga/platform';
import { shutdownTracing } from '@saga/tracing';
import { NotificationModule, loadNotificationEnv } from './notification.module';

const env = loadNotificationEnv();
runService(NotificationModule.forRoot(env), env.PORT).catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
process.once('SIGTERM', () => void shutdownTracing());
