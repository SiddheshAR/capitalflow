import { BadRequestException, Controller, Get, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import * as oidc from 'openid-client';

type LoginTransaction = {
  state: string;
  nonce: string;
  codeVerifier: string;
  expiresAt: number;
};

type LoginSession = Request['session'] & {
  oidcLogin?: LoginTransaction;
  user?: {
    subject: string;
    email?: string;
    displayName?: string;
  };
  accessToken?: string;
};

function saveSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.save((error) => (error ? reject(error) : resolve()));
  });
}

function regenerateSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.regenerate((error) => (error ? reject(error) : resolve()));
  });
}

@Controller('auth')
export class AuthController {
  constructor(private readonly config: ConfigService) {}

  private async oidcConfig(): Promise<oidc.Configuration> {
    const issuerUrl = new URL(this.config.getOrThrow<string>('OIDC_ISSUER'));
    const isLocalHttp =
      issuerUrl.protocol === 'http:' && issuerUrl.hostname === 'localhost';

    return oidc.discovery(
      issuerUrl,
      this.config.getOrThrow<string>('OIDC_CLIENT_ID'),
      this.config.getOrThrow<string>('OIDC_CLIENT_SECRET'),
      undefined,
      isLocalHttp
        ? { execute: [oidc.allowInsecureRequests] }
        : undefined,
    );
  }

  @Get('login')
  async login(@Req() req: Request, @Res() res: Response): Promise<void> {
    const oidcConfig = await this.oidcConfig();
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const codeChallenge =
      await oidc.calculatePKCECodeChallenge(codeVerifier);

    const loginSession = req.session as LoginSession;
    loginSession.oidcLogin = {
      state,
      nonce,
      codeVerifier,
      expiresAt: Date.now() + 10 * 60 * 1000,
    };

    // Persist the transaction before redirecting the browser.
    await saveSession(req);

    const authorizationUrl = oidc.buildAuthorizationUrl(oidcConfig, {
      redirect_uri: this.config.getOrThrow<string>('OIDC_REDIRECT_URI'),
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });

    res.redirect(authorizationUrl.href);
  }

  @Get('callback')
  async callback(@Req() req: Request, @Res() res: Response): Promise<void> {
    const loginSession = req.session as LoginSession;
    const transaction = loginSession.oidcLogin;

    if (!transaction || transaction.expiresAt <= Date.now()) {
      delete loginSession.oidcLogin;
      await saveSession(req);
      throw new BadRequestException('Login was not started or has expired');
    }

    // Consume the transaction so this callback cannot use it twice.
    delete loginSession.oidcLogin;
    await saveSession(req);

    let tokens;
    try {
      const redirectUri = this.config.getOrThrow<string>('OIDC_REDIRECT_URI');
      const callbackUrl = new URL(req.originalUrl, redirectUri);

      tokens = await oidc.authorizationCodeGrant(
        await this.oidcConfig(),
        callbackUrl,
        {
          expectedState: transaction.state,
          expectedNonce: transaction.nonce,
          pkceCodeVerifier: transaction.codeVerifier,
          idTokenExpected: true,
        },
      );
    } catch {
      throw new BadRequestException('Login could not be completed');
    }

    const claims = tokens.claims();
    if (!claims?.sub) {
      throw new BadRequestException('Login identity was missing');
    }

    // Replace the temporary session ID after successful authentication.
    await regenerateSession(req);
    const authenticatedSession = req.session as LoginSession;
    authenticatedSession.user = {
      subject: claims.sub,
      ...(typeof claims.email === 'string' ? { email: claims.email } : {}),
      ...(typeof claims.name === 'string'
        ? { displayName: claims.name }
        : {}),
    };
    authenticatedSession.accessToken = tokens.access_token;
    await saveSession(req);

    // res.status(200).json({ message: 'Login complete; /api/me comes next' });
    res.redirect('/api/me');
  }
} 