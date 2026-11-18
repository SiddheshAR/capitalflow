import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import Joi from 'joi';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { AuthController } from './auth.controller.js';
import { ApiController } from './api.controller.js';
import { HealthController } from './health.controller.js';
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: Joi.object({
        PORT: Joi.number().integer().min(1).max(65535).required(),
        OIDC_ISSUER: Joi.string().uri({ scheme: ['http', 'https'] }).required(),
        OIDC_CLIENT_ID: Joi.string().required(),
        OIDC_CLIENT_SECRET: Joi.string().invalid('REPLACE_ME').required(),
        OIDC_REDIRECT_URI: Joi.string().uri({ scheme: ['http', 'https'] }).required(),
        REDIS_URL: Joi.string().uri({ scheme: ['redis', 'rediss'] }).required(),
        SESSION_SECRET: Joi.string().min(32).invalid('REPLACE_WITH_LONG_RANDOM_VALUE').required(),
      }),
    }),
  ],
  controllers: [AppController, AuthController,ApiController,HealthController ],
  providers: [AppService],
})
export class AppModule {}
