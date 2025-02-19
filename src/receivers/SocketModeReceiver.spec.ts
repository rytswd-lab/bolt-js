import 'mocha';
import sinon, { SinonSpy } from 'sinon';
import { assert } from 'chai';
import rewiremock from 'rewiremock';
import { Logger, LogLevel } from '@slack/logger';
import { EventEmitter } from 'events';
import { IncomingMessage, ServerResponse } from 'http';
import { InstallProvider } from '@slack/oauth';
import { SocketModeClient } from '@slack/socket-mode';
import { Override, mergeOverrides } from '../test-helpers';
import { CustomRouteInitializationError } from '../errors';

// Fakes
class FakeServer extends EventEmitter {
  public on = sinon.fake();

  public listen = sinon.fake(() => {
    if (this.listeningFailure !== undefined) {
      this.emit('error', this.listeningFailure);
    }
  });

  public close = sinon.fake((...args: any[]) => {
    setImmediate(() => {
      this.emit('close');
      setImmediate(() => {
        args[0]();
      });
    });
  });

  public constructor(private listeningFailure?: Error) {
    super();
  }
}

describe('SocketModeReceiver', function () {
  beforeEach(function () {
    this.listener = (_req: any, _res: any) => {};
    this.fakeServer = new FakeServer();
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const that = this;
    this.fakeCreateServer = sinon.fake(function (handler: (req: any, res: any) => void) {
      that.listener = handler; // pick up the socket listener method so we can assert on its behaviour
      return that.fakeServer as FakeServer;
    });
  });

  const noopLogger: Logger = {
    debug(..._msg: any[]): void {
      /* noop */
    },
    info(..._msg: any[]): void {
      /* noop */
    },
    warn(..._msg: any[]): void {
      /* noop */
    },
    error(..._msg: any[]): void {
      /* noop */
    },
    setLevel(_level: LogLevel): void {
      /* noop */
    },
    getLevel(): LogLevel {
      return LogLevel.DEBUG;
    },
    setName(_name: string): void {
      /* noop */
    },
  };

  describe('constructor', function () {
    // NOTE: it would be more informative to test known valid combinations of options, as well as invalid combinations
    it('should accept supported arguments and use default arguments when not provided', async function () {
      // Arrange
      const overrides = mergeOverrides(
        withHttpCreateServer(this.fakeCreateServer),
        withHttpsCreateServer(sinon.fake.throws('Should not be used.')),
      );
      const SocketModeReceiver = await importSocketModeReceiver(overrides);

      const receiver = new SocketModeReceiver({
        appToken: 'my-secret',
        logger: noopLogger,
        clientId: 'my-clientId',
        clientSecret: 'my-client-secret',
        stateSecret: 'state-secret',
        scopes: ['channels:read'],
        installerOptions: {
          authVersion: 'v2',
          userScopes: ['chat:write'],
        },
      });
      assert.isNotNull(receiver);
      assert.isOk(this.fakeServer.listen.calledWith(3000));
    });
    it('should allow for customizing port the socket listens on', async function () {
      // Arrange
      const overrides = mergeOverrides(
        withHttpCreateServer(this.fakeCreateServer),
        withHttpsCreateServer(sinon.fake.throws('Should not be used.')),
      );
      const SocketModeReceiver = await importSocketModeReceiver(overrides);

      const customPort = 1337;
      const receiver = new SocketModeReceiver({
        appToken: 'my-secret',
        logger: noopLogger,
        clientId: 'my-clientId',
        clientSecret: 'my-client-secret',
        stateSecret: 'state-secret',
        scopes: ['channels:read'],
        installerOptions: {
          authVersion: 'v2',
          userScopes: ['chat:write'],
          port: customPort,
        },
      });
      assert.isNotNull(receiver);
      assert.isOk(this.fakeServer.listen.calledWith(customPort));
    });
    it('should invoke installer handleCallback if a request comes into the redirect URI path', async function () {
      // Arrange
      const installProviderStub = sinon.createStubInstance(InstallProvider);
      const overrides = mergeOverrides(
        withHttpCreateServer(this.fakeCreateServer),
        withHttpsCreateServer(sinon.fake.throws('Should not be used.')),
      );
      const SocketModeReceiver = await importSocketModeReceiver(overrides);

      const callbackOptions = {
        failure: () => {},
        success: () => {},
      };
      const receiver = new SocketModeReceiver({
        appToken: 'my-secret',
        logger: noopLogger,
        clientId: 'my-clientId',
        clientSecret: 'my-client-secret',
        stateSecret: 'state-secret',
        scopes: ['channels:read'],
        installerOptions: {
          authVersion: 'v2',
          userScopes: ['chat:write'],
          redirectUriPath: '/heyo',
          callbackOptions,
        },
      });
      assert.isNotNull(receiver);
      receiver.installer = installProviderStub as unknown as InstallProvider;
      const fakeReq = {
        url: '/heyo',
        method: 'GET',
      };
      const fakeRes = null;
      await this.listener(fakeReq, fakeRes);
      assert(
        installProviderStub.handleCallback.calledWith(
          fakeReq as IncomingMessage,
          fakeRes as unknown as ServerResponse,
          callbackOptions,
        ),
      );
    });
    it('should invoke installer generateInstallUrl if a request comes into the install path', async function () {
      // Arrange
      const installProviderStub = sinon.createStubInstance(InstallProvider);
      const overrides = mergeOverrides(
        withHttpCreateServer(this.fakeCreateServer),
        withHttpsCreateServer(sinon.fake.throws('Should not be used.')),
      );
      const SocketModeReceiver = await importSocketModeReceiver(overrides);

      const metadata = 'this is bat country';
      const scopes = ['channels:read'];
      const userScopes = ['chat:write'];
      const receiver = new SocketModeReceiver({
        appToken: 'my-secret',
        logger: noopLogger,
        clientId: 'my-clientId',
        clientSecret: 'my-client-secret',
        stateSecret: 'state-secret',
        scopes,
        installerOptions: {
          authVersion: 'v2',
          installPath: '/hiya',
          metadata,
          userScopes,
        },
      });
      assert.isNotNull(receiver);
      receiver.installer = installProviderStub as unknown as InstallProvider;
      const fakeReq = {
        url: '/hiya',
        method: 'GET',
      };
      const fakeRes = {
        writeHead: sinon.fake(),
        end: sinon.fake(),
      };
      await this.listener(fakeReq, fakeRes);
      assert(installProviderStub.generateInstallUrl.calledWith(sinon.match({ metadata, scopes, userScopes })));
      assert(fakeRes.writeHead.calledWith(200, sinon.match.object));
      assert(fakeRes.end.called);
    });
    it('should use a custom HTML renderer for the install path webpage', async function () {
      // Arrange
      const installProviderStub = sinon.createStubInstance(InstallProvider);
      const overrides = mergeOverrides(
        withHttpCreateServer(this.fakeCreateServer),
        withHttpsCreateServer(sinon.fake.throws('Should not be used.')),
      );
      const SocketModeReceiver = await importSocketModeReceiver(overrides);

      const metadata = 'this is bat country';
      const scopes = ['channels:read'];
      const userScopes = ['chat:write'];
      const receiver = new SocketModeReceiver({
        appToken: 'my-secret',
        logger: noopLogger,
        clientId: 'my-clientId',
        clientSecret: 'my-client-secret',
        stateSecret: 'state-secret',
        scopes,
        installerOptions: {
          authVersion: 'v2',
          installPath: '/hiya',
          renderHtmlForInstallPath: (_) => 'Hello world!',
          metadata,
          userScopes,
        },
      });
      assert.isNotNull(receiver);
      receiver.installer = installProviderStub as unknown as InstallProvider;
      const fakeReq = {
        url: '/hiya',
        method: 'GET',
      };
      const fakeRes = {
        writeHead: sinon.fake(),
        end: sinon.fake(),
      };
      /* eslint-disable-next-line @typescript-eslint/await-thenable */
      await this.listener(fakeReq, fakeRes);
      assert(installProviderStub.generateInstallUrl.calledWith(sinon.match({ metadata, scopes, userScopes })));
      assert(fakeRes.writeHead.calledWith(200, sinon.match.object));
      assert(fakeRes.end.called);
      assert.isTrue(fakeRes.end.calledWith('Hello world!'));
    });
    it('should redirect installers if directInstall is true', async function () {
      // Arrange
      const installProviderStub = sinon.createStubInstance(InstallProvider);
      const overrides = mergeOverrides(
        withHttpCreateServer(this.fakeCreateServer),
        withHttpsCreateServer(sinon.fake.throws('Should not be used.')),
      );
      const SocketModeReceiver = await importSocketModeReceiver(overrides);

      const metadata = 'this is bat country';
      const scopes = ['channels:read'];
      const userScopes = ['chat:write'];
      const receiver = new SocketModeReceiver({
        appToken: 'my-secret',
        logger: noopLogger,
        clientId: 'my-clientId',
        clientSecret: 'my-client-secret',
        stateSecret: 'state-secret',
        scopes,
        installerOptions: {
          authVersion: 'v2',
          installPath: '/hiya',
          directInstall: true,
          metadata,
          userScopes,
        },
      });
      assert.isNotNull(receiver);
      receiver.installer = installProviderStub as unknown as InstallProvider;
      const fakeReq = {
        url: '/hiya',
        method: 'GET',
      };
      const fakeRes = {
        writeHead: sinon.fake(),
        end: sinon.fake(),
      };
      /* eslint-disable-next-line @typescript-eslint/await-thenable */
      await this.listener(fakeReq, fakeRes);
      assert(installProviderStub.generateInstallUrl.calledWith(sinon.match({ metadata, scopes, userScopes })));
      assert(fakeRes.writeHead.calledWith(302, sinon.match.object));
      assert(fakeRes.end.called);
    });

    it('should call custom route handler only if request matches route path and method', async function () {
      // Arrange
      const installProviderStub = sinon.createStubInstance(InstallProvider);
      const overrides = mergeOverrides(
        withHttpCreateServer(this.fakeCreateServer),
        withHttpsCreateServer(sinon.fake.throws('Should not be used.')),
      );
      const SocketModeReceiver = await importSocketModeReceiver(overrides);
      const customRoutes = [{ path: '/test', method: ['get', 'POST'], handler: sinon.fake() }];

      const receiver = new SocketModeReceiver({
        appToken: 'my-secret',
        customRoutes,
      });
      assert.isNotNull(receiver);
      receiver.installer = installProviderStub as unknown as InstallProvider;

      const fakeReq: IncomingMessage = sinon.createStubInstance(IncomingMessage) as IncomingMessage;
      const fakeRes = { writeHead: sinon.fake(), end: sinon.fake() };

      fakeReq.url = '/test';
      fakeReq.headers = { host: 'localhost' };

      fakeReq.method = 'GET';
      await this.listener(fakeReq, fakeRes);
      assert(customRoutes[0].handler.calledWith(fakeReq, fakeRes));

      fakeReq.method = 'POST';
      await this.listener(fakeReq, fakeRes);
      assert(customRoutes[0].handler.calledWith(fakeReq, fakeRes));

      fakeReq.method = 'UNHANDLED_METHOD';
      await this.listener(fakeReq, fakeRes);
      assert(fakeRes.writeHead.calledWith(404, sinon.match.object));
      assert(fakeRes.end.called);
    });

    it("should throw an error if customRoutes don't have the required keys", async function () {
      // Arrange
      const overrides = mergeOverrides(
        withHttpCreateServer(this.fakeCreateServer),
        withHttpsCreateServer(sinon.fake.throws('Should not be used.')),
      );
      const SocketModeReceiver = await importSocketModeReceiver(overrides);
      const customRoutes = [{ handler: sinon.fake() }] as any;

      assert.throws(() => new SocketModeReceiver({ appToken: 'my-secret', customRoutes }), CustomRouteInitializationError);
    });

    it('should return a 404 if a request passes the install path, redirect URI path and custom routes', async function () {
      // Arrange
      const installProviderStub = sinon.createStubInstance(InstallProvider);
      const overrides = mergeOverrides(
        withHttpCreateServer(this.fakeCreateServer),
        withHttpsCreateServer(sinon.fake.throws('Should not be used.')),
      );
      const SocketModeReceiver = await importSocketModeReceiver(overrides);

      const metadata = 'this is bat country';
      const scopes = ['channels:read'];
      const userScopes = ['chat:write'];
      const customRoutes = [{ path: '/test', method: ['get', 'POST'], handler: sinon.fake() }];
      const receiver = new SocketModeReceiver({
        appToken: 'my-secret',
        logger: noopLogger,
        clientId: 'my-clientId',
        clientSecret: 'my-client-secret',
        stateSecret: 'state-secret',
        scopes,
        customRoutes,
        installerOptions: {
          authVersion: 'v2',
          installPath: '/hiya',
          redirectUriPath: '/heyo',
          metadata,
          userScopes,
        },
      });
      assert.isNotNull(receiver);
      receiver.installer = installProviderStub as unknown as InstallProvider;
      const fakeReq = {
        url: '/nope',
        method: 'GET',
      };
      const fakeRes = {
        writeHead: sinon.fake(),
        end: sinon.fake(),
      };
      await this.listener(fakeReq, fakeRes);
      assert(fakeRes.writeHead.calledWith(404, sinon.match.object));
      assert(fakeRes.end.calledOnce);
    });
  });
  describe('#start()', function () {
    it('should invoke the SocketModeClient start method', async function () {
      // Arrange
      const clientStub = sinon.createStubInstance(SocketModeClient);
      const overrides = mergeOverrides(
        withHttpCreateServer(this.fakeCreateServer),
        withHttpsCreateServer(sinon.fake.throws('Should not be used.')),
      );
      const SocketModeReceiver = await importSocketModeReceiver(overrides);

      const receiver = new SocketModeReceiver({
        appToken: 'my-secret',
        logger: noopLogger,
        clientId: 'my-clientId',
        clientSecret: 'my-client-secret',
        stateSecret: 'state-secret',
        scopes: ['channels:read'],
        installerOptions: {
          authVersion: 'v2',
          userScopes: ['chat:write'],
        },
      });
      assert.isNotNull(receiver);
      receiver.client = clientStub as unknown as SocketModeClient;
      await receiver.start();
      assert(clientStub.start.called);
    });
  });
  describe('#stop()', function () {
    it('should invoke the SocketModeClient disconnect method', async function () {
      // Arrange
      const clientStub = sinon.createStubInstance(SocketModeClient);
      const overrides = mergeOverrides(
        withHttpCreateServer(this.fakeCreateServer),
        withHttpsCreateServer(sinon.fake.throws('Should not be used.')),
      );
      const SocketModeReceiver = await importSocketModeReceiver(overrides);

      const receiver = new SocketModeReceiver({
        appToken: 'my-secret',
        logger: noopLogger,
        clientId: 'my-clientId',
        clientSecret: 'my-client-secret',
        stateSecret: 'state-secret',
        scopes: ['channels:read'],
        installerOptions: {
          authVersion: 'v2',
          userScopes: ['chat:write'],
        },
      });
      assert.isNotNull(receiver);
      receiver.client = clientStub as unknown as SocketModeClient;
      await receiver.stop();
      assert(clientStub.disconnect.called);
    });
  });
});

/* Testing Harness */

// Loading the system under test using overrides
async function importSocketModeReceiver(
  overrides: Override = {},
): Promise<typeof import('./SocketModeReceiver').default> {
  return (await rewiremock.module(() => import('./SocketModeReceiver'), overrides)).default;
}

// Composable overrides
function withHttpCreateServer(spy: SinonSpy): Override {
  return {
    http: {
      createServer: spy,
    },
  };
}

function withHttpsCreateServer(spy: SinonSpy): Override {
  return {
    https: {
      createServer: spy,
    },
  };
}
