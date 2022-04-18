import { isBrowser, isNode } from 'browser-or-node';
import {
  fetchEventSource,
  EventSourceMessage,
} from '@microsoft/fetch-event-source';

import {
  Scry,
  Thread,
  AuthenticationInterface,
  PokeInterface,
  SubscriptionRequestInterface,
  headers,
  SSEOptions,
  PokeHandlers,
  Message,
  FatalError,
  Handler,
} from './types';
import { hexString } from './utils';

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
    public url: string,
    public code?: string,
    public handlers?: Handler[],
    public desk?: string
  ) {
    if (isBrowser) {
      window.addEventListener('beforeunload', this.delete);
    }
    return this;
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
    verbose = false,
  }: AuthenticationInterface) {
    const airlock = new UrbitMock('');
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
    return Promise.resolve();
  }

  /**
   * Initializes the SSE pipe for the appropriate channel.
   */
  async eventSource(): Promise<void> {
    return Promise.resolve();
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
    const message: Message = {
      id: this.getEventId(),
      action: 'poke',
      ship,
      app,
      mark,
      json,
    };
    const [send, result] = await Promise.all([
      new Promise((resolve) => {
        resolve();
      }),
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

    // await this.sendJSONtoChannel(message);

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
  async scry(params: Scry) {
    const { app, path } = params;

    const handler = this.handlers
      ?.find((h) => h.path === path && h.app === app)

    if (!handler) {
      throw new Error(`Mock scry: Cannot find handler for app:${app} and path:${path}`)
    }
    const response =  handler.func();


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
  async thread<T = any>(params: Thread<T>) {
    const {
      inputMark,
      outputMark,
      threadName,
      body,
      desk = this.desk,
    } = params;
    if (!desk) {
      throw new Error('Must supply desk to run thread from');
    }

    const handler = this.handlers
      ?.find((h) => h.desk === desk && h.threadName === threadName)

    if (!handler) {
      throw new Error(`mock thread: Cannot find handler for desk:${desk} and thread:${threadName}`)
    }

    const response = handler.func();

    return response;
  }

  /**
   * Utility function to connect to a ship that has its *.arvo.network domain configured.
   *
   * @param name Name of the ship e.g. zod
   * @param code Code to log in
   */
  static async onArvoNetwork(ship: string, code: string): Promise<UrbitMock> {
    const url = `https://${ship}.arvo.network`;
    return await UrbitMock.authenticate({ ship, url, code });
  }
}

export default UrbitMock;
