import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { RedisStore } from 'connect-redis';
import session from 'express-session';
import { createClient } from 'redis';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

  const redisClient = createClient({
    url: config.getOrThrow<string>('REDIS_URL'),
    disableOfflineQueue: true,
    socket: {
      connectTimeout: 5000,
      reconnectStrategy: (retries) =>
        retries > 3 ? false : Math.min(retries * 100, 1000),
    },
  });

  redisClient.on('error', () => {
    console.error('Redis session connection error');
  });

  // Do not accept requests until the session store is available.
  await redisClient.connect();

  app.use(
    session({
      name: 'bff.sid',
      store: new RedisStore({
        client: redisClient,
        prefix: 'bff:sess:',
      }),
      secret: config.getOrThrow<string>('SESSION_SECRET'),
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: false, // Local HTTP only; use true behind HTTPS.
        path: '/',
        maxAge: 30 * 60 * 1000,
      },
    }),
  );

  const port = config.getOrThrow<number>('PORT');
  await app.listen(port);
}

await bootstrap();