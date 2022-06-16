import * as fetch from '../account/fetch';
import { database } from '../main/database';
import * as models from '../models';

export async function globalBeforeEach() {
  // Setup the local database in case it's used
  fetch.setup('insomnia-tests', 'http://localhost:8000');

  await database.init(
    models.types(),
    {
      inMemoryOnly: true,
    },
    () => {},
  );
}
