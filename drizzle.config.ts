import {defineConfig} from 'drizzle-kit';
export default defineConfig({out:'./qa/sqlite-migrations',schema:'./db/schema.ts',dialect:'sqlite'});
