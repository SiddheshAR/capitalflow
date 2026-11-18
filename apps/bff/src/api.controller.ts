import { Controller, Get, Req, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

type SignedInSession = Request['session'] & {
  user?: {
    subject: string;
    email?: string;
    displayName?: string;
  };
};

@Controller('api')
export class ApiController {
  @Get('me')
  getMe(@Req() req: Request) {
    const user = (req.session as SignedInSession).user;

    if (!user) {
      throw new UnauthorizedException();
    }

    return user;
  }
}