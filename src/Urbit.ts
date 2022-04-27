import { isBrowser } from 'browser-or-node';
import {
  Scry,
  Thread,
  AuthenticationInterface,
  PokeInterface,
  SubscriptionRequestInterface,
  headers,
  PokeHandlers,
  Message,
  Handler,
  Poke,
  isSubscriptionHandler,
  isPokeHandler,
  isScryHandler,
  isThreadHandler,
  UrbitResponse,
} from './types';
import { hexString } from './utils';
import { setupWorker, rest } from 'msw';

/**
 * A class for mocking interactions with an urbit ship, given a set of handlers.
 */
export class UrbitMock {
  /**
   * UID will be used for the channel: The current unix time plus a random hex string
   */
  private uid: string = `${Math.floor(Date.now() / 1000)}-${hexString(6)}`;

  /**
   * Last Event ID is an auto-updated index of which events have been sent over this channel
   */
  private lastEventId: number = 0;

  private lastAcknowledgedEventId: number = 0;

  /**
   * SSE Client is null for now; we don't want to start polling until it the channel exists
   */
  private sseClientInitialized: boolean = false;

  /**
   * Cookie gets set when we log in.
   */
  cookie?: string | undefined;

  /**
   * A registry of requestId to successFunc/failureFunc
   *
   * These functions are registered during a +poke and are executed
   * in the onServerEvent()/onServerError() callbacks. Only one of
   * the functions will be called, and the outstanding poke will be
   * removed after calling the success or failure function.
   */

  private outstandingPokes: Map<number, PokeHandlers> = new Map();

  /**
   * A registry of requestId to subscription functions.
   *
   * These functions are registered during a +subscribe and are
   * executed in the onServerEvent()/onServerError() callbacks. The
   * event function will be called whenever a new piece of data on this
   * subscription is available, which may be 0, 1, or many times. The
   * disconnect function may be called exactly once.
   */
  private outstandingSubscriptions: Map<number, SubscriptionRequestInterface> =
    new Map();

  /**
   * Our abort controller, used to close the connection
   */
  private abort = new AbortController();

  /**
   * Ship can be set, in which case we can do some magic stuff like send chats
   */
  ship?: string | null;

  /**
   * If verbose, logs output eagerly.
   */
  verbose?: boolean;

  /**
   * number of consecutive errors in connecting to the eventsource
   */
  private errorCount = 0;

  onError?: (error: any) => void = null;

  onRetry?: () => void = null;

  onOpen?: () => void = null;

  /** This is basic interpolation to get the channel URL of an instantiated Urbit connection. */
  private get channelUrl(): string {
    return `${this.url}/~/channel/${this.uid}`;
  }

  private get fetchOptions(): any {
    const headers: headers = {
      'Content-Type': 'application/json',
    };
    if (!isBrowser) {
      headers.Cookie = this.cookie;
    }
    return {
      credentials: 'include',
      accept: '*',
      headers,
      signal: this.abort.signal,
    };
  }

  /**
   * Constructs a new Urbit connection.
   *
   * @param url  The URL (with protocol and port) of the ship to be accessed. If
   * the airlock is running in a webpage served by the ship, this should just
   * be the empty string.
   * @param code The access code for the ship at that address
   */
  constructor(
    public handlers: Handler[],
    public url: string,
    public code?: string,
    public desk?: string
  ) {
    if (isBrowser) {
      const sseMock = rest.put(
        `${this.url}/~/channel/${this.uid}`,
        (req, res, ctx) => {
          // @ts-ignore
          const requestBody = req.body[0];
          const { action, app, path, mark } = requestBody;
          const subscribeHandler = this.handlers
            .filter(isSubscriptionHandler)
            .find(
              (h) => h.action === action && h.app === app && h.path === path
            );
          const pokeHandler = this.handlers
            .filter(isPokeHandler)
            .find(
              (h) => h.action === action && h.app === app && h.mark === mark
            );
          const handler = subscribeHandler || pokeHandler;
          if (!handler) {
            throw new Error(
              `Mock subscribe/pokeHandler: Cannot find handler for app:${app}, path: ${path} and action:${action} OR ${app} and ${mark} and ${action} (for pokes)`
            );
          }

          const data = handler.initialResponder
            ? handler.initialResponder(requestBody)
            : createResponse(requestBody);
          this.handleEvents(data);
          const respond =
            handler.immediateResponder || (async () => requestBody.id);
          const responseBody = respond(requestBody);
          return res(
            ctx.status(200),
            ctx.set('Connection', 'keep-alive'),
            ctx.set('Content-Type', 'text/event-stream'),
            ctx.body(JSON.stringify(responseBody))
          );
        }
      );

      const worker = setupWorker(sseMock);

      worker.start();
      window.addEventListener('beforeunload', this.delete);
    }
    return this;
  }

  handleEvents(data: UrbitResponse<any>) {
    if (data.response === 'poke' && this.outstandingPokes.has(data.id)) {
      const funcs = this.outstandingPokes.get(data.id);
      if (data.hasOwnProperty('ok')) {
        funcs.onSuccess();
      } else if (data.hasOwnProperty('err')) {
        console.error(data.err);
        funcs.onError(data.err);
      } else {
        console.error('Invalid poke response', data);
      }
      this.outstandingPokes.delete(data.id);
    } else if (
      data.response === 'subscribe' &&
      this.outstandingSubscriptions.has(data.id)
    ) {
      const funcs = this.outstandingSubscriptions.get(data.id);
      if (data.hasOwnProperty('err')) {
        console.error(data.err);
        funcs.err(data.err, data.id.toString());
        this.outstandingSubscriptions.delete(data.id);
      }
    } else if (
      data.response === 'diff' &&
      this.outstandingSubscriptions.has(data.id)
    ) {
      const funcs = this.outstandingSubscriptions.get(data.id);
      try {
        funcs.event(data.json);
      } catch (e) {
        console.error('Failed to call subscription event callback', e);
      }
    } else if (
      data.response === 'quit' &&
      this.outstandingSubscriptions.has(data.id)
    ) {
      const funcs = this.outstandingSubscriptions.get(data.id);
      funcs.quit(data);
      this.outstandingSubscriptions.delete(data.id);
    } else {
      console.log([...this.outstandingSubscriptions.keys()]);
      console.log('Unrecognized response', data);
    }
  }

  /**
   * All-in-one hook-me-up.
   *
   * Given a ship, url, and code, this returns an airlock connection
   * that is ready to go. It `|hi`s itself to create the channel,
   * then opens the channel via EventSource.
   *
   */
  static async authenticate({
    ship,
    url,
    code,
    handlers,
    verbose = false,
  }: AuthenticationInterface) {
    const airlock = new UrbitMock(handlers, url, code);
    airlock.verbose = verbose;
    airlock.ship = ship;
    await airlock.connect();
    await airlock.poke({
      app: 'hood',
      mark: 'helm-hi',
      json: 'opening airlock',
    });
    await airlock.eventSource();
    return airlock;
  }

  /**
   * Connects to the Urbit ship. Nothing can be done until this is called.
   * That's why we roll it into this.authenticate
   */
  async connect(): Promise<void> {
    return Promise.resolve(null);
  }

  /**
   * Initializes the SSE pipe for the appropriate channel.
   */
  async eventSource(): Promise<void> {
    return Promise.resolve(null);
  }

  /**
   * Reset airlock, abandoning current subscriptions and wiping state
   *
   */
  reset() {
    if (this.verbose) {
      console.log('resetting');
    }
    this.delete();
    this.abort.abort();
    this.abort = new AbortController();
    this.uid = `${Math.floor(Date.now() / 1000)}-${hexString(6)}`;
    this.lastEventId = 0;
    this.lastAcknowledgedEventId = 0;
    this.outstandingSubscriptions = new Map();
    this.outstandingPokes = new Map();
    this.sseClientInitialized = false;
  }

  /**
   * Autoincrements the next event ID for the appropriate channel.
   */
  private getEventId(): number {
    this.lastEventId = Number(this.lastEventId) + 1;
    return this.lastEventId;
  }

  /**
   * Acknowledges an event.
   *
   * @param eventId The event to acknowledge.
   */
  private async ack(eventId: number): Promise<number | void> {
    this.lastAcknowledgedEventId = eventId;
    const message: Message = {
      action: 'ack',
      'event-id': eventId,
    };
    await this.sendJSONtoChannel(message);
    return eventId;
  }

  private async sendJSONtoChannel(...json: Message[]): Promise<void> {
    const response = await fetch(this.channelUrl, {
      ...this.fetchOptions,
      method: 'PUT',
      body: JSON.stringify(json),
    });
    if (!response.ok) {
      throw new Error('Failed to PUT channel');
    }
    if (!this.sseClientInitialized) {
      await this.eventSource();
    }
  }

  /**
   * Creates a subscription, waits for a fact and then unsubscribes
   *
   * @param app Name of gall agent to subscribe to
   * @param path Path to subscribe to
   * @param timeout Optional timeout before ending subscription
   *
   * @returns The first fact on the subcription
   */
  async subscribeOnce<T = any>(app: string, path: string, timeout?: number) {
    return new Promise<T>(async (resolve, reject) => {
      let done = false;
      let id: number | null = null;
      const quit = () => {
        if (!done) {
          reject('quit');
        }
      };
      const event = (e: T) => {
        if (!done) {
          resolve(e);
          this.unsubscribe(id);
        }
      };
      const request = { app, path, event, err: reject, quit };

      id = await this.subscribe(request);

      if (timeout) {
        setTimeout(() => {
          if (!done) {
            done = true;
            reject('timeout');
            this.unsubscribe(id);
          }
        }, timeout);
      }
    });
  }

  /**
   * Pokes a ship with data.
   *
   * @param app The app to poke
   * @param mark The mark of the data being sent
   * @param json The data to send
   */
  async poke<T>(params: PokeInterface<T>): Promise<number> {
    const { app, mark, json, ship, onSuccess, onError } = {
      onSuccess: () => {},
      onError: () => {},
      ship: this.ship,
      ...params,
    };
    const message: Message & Poke<T> = {
      id: this.getEventId(),
      action: 'poke',
      ship,
      app,
      mark,
      json,
    };
    const [, result] = await Promise.all([
      this.sendJSONtoChannel(message),
      new Promise<number>((resolve, reject) => {
        this.outstandingPokes.set(message.id, {
          onSuccess: () => {
            onSuccess();
            resolve(message.id);
          },
          onError: (event) => {
            onError(event);
            reject(event.err);
          },
        });
      }),
    ]);

    const pokeHandler = this.handlers
      .filter(isPokeHandler)
      .find((h) => h.app === app && h.mark === mark);
    debugger;

    if (!pokeHandler) {
      return result;
    }

    const returnSub = pokeHandler.returnSubscription;
    const [key] = [...this.outstandingSubscriptions.entries()].find(
      ([, s]) => s.app === returnSub.app && s.path === returnSub.path
    );
    setTimeout(() => {
      this.handleEvents({ ...pokeHandler.dataResponder(message), id: key });
    }, Math.random() * 100 + 75);

    return result;
  }

  /**
   * Subscribes to a path on an app on a ship.
   *
   *
   * @param app The app to subsribe to
   * @param path The path to which to subscribe
   * @param handlers Handlers to deal with various events of the subscription
   */
  async subscribe(params: SubscriptionRequestInterface): Promise<number> {
    const { app, path, ship, err, event, quit } = {
      err: () => {},
      event: () => {},
      quit: () => {},
      ship: this.ship,
      ...params,
    };

    const message: Message = {
      id: this.getEventId(),
      action: 'subscribe',
      ship,
      app,
      path,
    };

    this.outstandingSubscriptions.set(message.id, {
      app,
      path,
      err,
      event,
      quit,
    });

    await this.sendJSONtoChannel(message);

    return message.id;
  }

  /**
   * Unsubscribes to a given subscription.
   *
   * @param subscription
   */
  async unsubscribe(subscription: number) {
    return this.sendJSONtoChannel({
      id: this.getEventId(),
      action: 'unsubscribe',
      subscription,
    }).then(() => {
      this.outstandingSubscriptions.delete(subscription);
    });
  }

  /**
   * Deletes the connection to a channel.
   */
  delete() {
    if (isBrowser) {
      navigator.sendBeacon(
        this.channelUrl,
        JSON.stringify([
          {
            action: 'delete',
          },
        ])
      );
    } else {
      // TODO
      // this.sendMessage('delete');
    }
  }

  /**
   * Scry into an gall agent at a path
   *
   * @typeParam T - Type of the scry result
   *
   * @remarks
   *
   * Equivalent to
   * ```hoon
   * .^(T %gx /(scot %p our)/[app]/(scot %da now)/[path]/json)
   * ```
   * The returned cage must have a conversion to JSON for the scry to succeed
   *
   * @param params The scry request
   * @returns The scry result
   */
  async scry<T>(params: Scry): Promise<T> {
    const { app, path } = params;

    const handler = this.handlers
      .filter(isScryHandler)
      .find((h) => h.path === path && h.app === app);

    if (!handler) {
      throw new Error(
        `Mock scry: Cannot find handler for app:${app} and path:${path}`
      );
    }
    const response = handler.func(params);

    return response;
  }

  /**
   * Run a thread
   *
   *
   * @param inputMark   The mark of the data being sent
   * @param outputMark  The mark of the data being returned
   * @param threadName  The thread to run
   * @param body        The data to send to the thread
   * @returns  The return value of the thread
   */
  async thread<R, T = any>(params: Thread<T>): Promise<R> {
    const { threadName, desk = this.desk } = params;
    if (!desk) {
      throw new Error('Must supply desk to run thread from');
    }

    const handler = this.handlers
      .filter(isThreadHandler)
      .find((h) => h.desk === desk && h.threadName === threadName);

    if (!handler) {
      throw new Error(
        `mock thread: Cannot find handler for desk:${desk} and thread:${threadName}`
      );
    }

    const response = handler.func<T>(params);

    return response;
  }

  /**
   * Utility function to connect to a ship that has its *.arvo.network domain configured.
   *
   * @param name Name of the ship e.g. zod
   * @param code Code to log in
   */
  static async onArvoNetwork(
    ship: string,
    code: string,
    handlers: Handler[]
  ): Promise<UrbitMock> {
    const url = `https://${ship}.arvo.network`;
    return await UrbitMock.authenticate({ ship, url, code, handlers });
  }
}

export function createResponse<Action, Response>(
  req: Message & (Poke<Action> | SubscriptionRequestInterface),
  data?: Response
): UrbitResponse<Response> {
  return {
    ok: true,
    id: req.id || 0,
    response: req.action as 'poke' | 'subscribe',
    json: data || req.json,
  };
}

export default UrbitMock;
