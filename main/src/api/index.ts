import { getLogger } from 'log4js';
import env from '../models/env';
import richHeader from './richHeader';
import telegramAvatar from './telegramAvatar';
import '@bogeychan/elysia-polyfills/node/index.js';
import { Elysia } from 'elysia';
import ui from './ui';
import q2tgServlet from './q2tgServlet';

const log = getLogger('Web Api');

let app = new Elysia()
  .onError(error => {
    log.error(error.request.method, error.request.url, error.error.message);
    log.debug(error.error);
  })
  .get('/', () => {
    return { hello: 'Q2TG' };
  })
  .use(telegramAvatar)
  .use(richHeader)
  .use(ui)
  .use(q2tgServlet);

export default {
  startListening() {
    app.listen(env.LISTEN_PORT);
    log.info('Listening on', env.LISTEN_PORT);
  },
};

export type App = typeof app;
