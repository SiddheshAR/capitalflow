import { Controller, Get, Res, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import { DbService } from './db.service.js';

@Controller('health')
export class AppController {
  constructor(private readonly dbService: DbService) {}

  @Get('live')
  getLive(@Res() res: Response) {
    return res.status(HttpStatus.OK).json({ status: 'ok' });
  }

  @Get('ready')
  async getReady(@Res() res: Response) {
    const isDbReady = await this.dbService.checkConnection();
    if (isDbReady) {
      return res.status(HttpStatus.OK).json({ status: 'ready' });
    } else {
      return res.status(HttpStatus.SERVICE_UNAVAILABLE).json({ status: 'unavailable' });
    }
  }
}
