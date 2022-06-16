import { database as hostDatabase } from '../main/database';
import { database as clientDatabase } from '../ui/database';
import type { Query } from './dbtypes';

export { Query };

export const database = process.type === 'renderer' ? clientDatabase : hostDatabase;
