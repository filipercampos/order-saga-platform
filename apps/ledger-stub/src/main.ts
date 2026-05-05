import { LedgerStub } from './ledger-stub';

// Local development only: every wallet starts with LEDGER_STUB_DEFAULT_BALANCE minor units.
const stub = new LedgerStub(BigInt(process.env.LEDGER_STUB_DEFAULT_BALANCE ?? '1000000'));
stub
  .listen(Number(process.env.PORT ?? 3105))
  .then((url) => console.log(JSON.stringify({ msg: 'ledger stub listening', url })))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
process.once('SIGTERM', () => void stub.close().then(() => process.exit(0)));
