import { registerPostgresTests } from '../helpers/test-backends.ts';
await registerPostgresTests(() => import('../facts-keyset-scan.test.ts'));
