import {
  CognitoAccessToken,
  CognitoIdToken,
  CognitoRefreshToken,
  CognitoUser,
  CognitoUserPool,
  CognitoUserSession,
} from 'amazon-cognito-identity-js';
import { Amplify, Auth } from 'aws-amplify';
import * as constants from './const';
import Express from 'express';
import EventEmitter from 'events';
import path from 'path';
import ip from 'ip';
import fs from 'fs';
import fetch from 'node-fetch';

type Credentials = {
  idToken: string;
  accessToken: string;
  refreshToken: string;
};

let idToken: string | undefined;

const getCredentialsFromSession = async (user): Promise<Credentials | null> => {
  return new Promise<Credentials | null>((resolve) => {
    user.getSession((err, session) => {
      if (err) {
        resolve(null);
        return;
      }

      resolve({
        idToken: session.idToken.jwtToken,
        accessToken: session.accessToken.jwtToken,
        refreshToken: session.refreshToken.token,
      });
    });
  });
};

const logInWithStoredCreds = async (
  config,
  idToken,
  accessToken,
  refreshToken,
): Promise<Credentials | null> => {
  const userPool = new CognitoUserPool({
    UserPoolId: constants.COGNITO_USER_POOL_ID,
    ClientId: constants.COGNITO_USER_POOL_CLIENT,
  });
  const cognitoIdToken = new CognitoIdToken({
    IdToken: idToken,
  });
  const cognitoAccessToken = new CognitoAccessToken({
    AccessToken: accessToken,
  });
  const cognitoRefreshToken = new CognitoRefreshToken({
    RefreshToken: refreshToken,
  });
  const user = new CognitoUser({
    Username: config.email,
    Pool: userPool,
  });
  user.setSignInUserSession(
    new CognitoUserSession({
      AccessToken: cognitoAccessToken,
      IdToken: cognitoIdToken,
      RefreshToken: cognitoRefreshToken,
    }),
  );

  return getCredentialsFromSession(user);
};

export const kwiksetLogin = async (config, log, api) => {
  const kwiksetSavePath = `${api.user.storagePath()}\\homebridge-kwikset-halo.json`;
  log.debug(`Storage path: ${kwiksetSavePath}`);

  let savedCreds;
  if (fs.existsSync(kwiksetSavePath)) {
    savedCreds = JSON.parse(fs.readFileSync(kwiksetSavePath, 'utf8'));
  }

  log.debug('Running login...');

  Amplify.configure({
    Auth: {
      region: constants.COGNITO_AWS_REGION,
      userPoolId: constants.COGNITO_USER_POOL_ID,
      userPoolWebClientId: constants.COGNITO_USER_POOL_CLIENT,
      authenticationFlowType: 'CUSTOM_AUTH',
    },
  });

  log.debug('Logging in via cached tokens');

  let credentials = savedCreds
    ? await logInWithStoredCreds(
        config,
        savedCreds.idToken,
        savedCreds.accessToken,
        savedCreds.refreshToken,
      )
    : null;
  if (!credentials) {
    log.warn('Failed to login with cached tokens, reauthenticating...');
    let user;
    try {
      user = await Auth.signIn(config.email, config.password);
    } catch (err) {
      log.error(`Failed to log in: ${err} - Make sure your username and password are correct.`);
      return;
    }

    if (user.challengeName === 'CUSTOM_CHALLENGE') {
      await Auth.sendCustomChallengeAnswer(
        user,
        'answerType:generateCode,medium:phone,codeType:login',
      );
      log.info('Generated mfa code, waiting for input');

      let server: any = null;
      const mfaCodeSignal = new EventEmitter();
      const app = Express();
      app.use(Express.static(path.resolve('static')));
      app.use(Express.urlencoded({ extended: true }));
      app.post('/submitmfa', (req, res) => {
        mfaCodeSignal.emit('code', req.body.code);
        mfaCodeSignal.once('authFeedback', async (success) => {
          if (success) {
            await res.redirect('/success.html');
            setTimeout(() => {
              server?.close();
            }, 7000);
          } else {
            res.redirect('/?error=bad+code');
          }
        });
      });

      server = app.listen(config.mfaPort, () => {
        log.info(`MFA server listening on http://${ip.address()}:${config.mfaPort}/index.html`);
      });

      let codeVerified = false;
      do {
        const authSuccess = await new Promise<boolean>((resolve) => {
          mfaCodeSignal.once('code', async (code) => {
            log.info(`Input received: ${code}. Verifying...`);
            await Auth.sendCustomChallengeAnswer(
              user,
              `answerType:verifyCode,medium:phone,codeType:login,code:${code}`,
            );
            try {
              const authenticatedUser = await Auth.currentAuthenticatedUser();
              credentials = await getCredentialsFromSession(authenticatedUser);
              resolve(true);
            } catch (err) {
              log.error(`Failed to verify mfa code: ${err} - Try again.`);
              resolve(false);
            }
          });
        });

        mfaCodeSignal.emit('authFeedback', authSuccess);
        codeVerified = authSuccess;
      } while (!codeVerified);
      log.info('Code verified!');

      const creds = await getCredentialsFromSession(await Auth.currentAuthenticatedUser());
      fs.writeFileSync(kwiksetSavePath, JSON.stringify(creds));
      log.debug('Credentials saved!');
    } else {
      log.error(`Unknown auth challenge name ${user.challengeName}`);
    }
  }

  idToken = credentials?.idToken;
  log.info('Logged in!');
};

export const apiRequest = async (log, opts: { path: string; method: string; body?: any }) => {
  const apiHeaders = {
    Host: constants.API_HOST,
    'User-Agent': constants.API_USER_AGENT,
    'Accept-Encoding': 'gzip',
    Authorization: `Bearer ${idToken}`,
  };

  return fetch(`https://${constants.API_HOST}/${opts.path}`, {
    method: opts.method,
    headers: apiHeaders,
    body: opts.body,
  });
};
