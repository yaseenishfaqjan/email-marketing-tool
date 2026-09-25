// Load .env first, so a developer with a real local database gets the
// integration tests rather than eight silent skips. The defaults below only
// fill what .env did not set.
import 'dotenv/config';

process.env.DATABASE_URL ||= 'postgres://localhost:5432/mailer_test';
process.env.TOKEN_SECRET ||= 'test-token-secret-value-0123456789abcdef';
process.env.ADMIN_TOKEN ||= 'test-admin-token';
process.env.PUBLIC_URL ||= 'https://links.example.com';
