/** @module Interface wasi:sockets/tcp@0.2.12 **/
export type Network = import('./wasi-sockets-network.js').Network;
export type IpSocketAddress = import('./wasi-sockets-network.js').IpSocketAddress;
export type ErrorCode = import('./wasi-sockets-network.js').ErrorCode;
export type InputStream = import('./wasi-io-streams.js').InputStream;
export type OutputStream = import('./wasi-io-streams.js').OutputStream;
/**
 * # Variants
 * 
 * ## `"receive"`
 * 
 * ## `"send"`
 * 
 * ## `"both"`
 */
export type ShutdownType = 'receive' | 'send' | 'both';
export type Pollable = import('./wasi-io-poll.js').Pollable;

export class TcpSocket {
  /**
   * This type does not have a public constructor.
   */
  private constructor();
  startBind(network: Network, localAddress: IpSocketAddress): void;
  finishBind(): void;
  startListen(): void;
  finishListen(): void;
  accept(): [TcpSocket, InputStream, OutputStream];
  localAddress(): IpSocketAddress;
  subscribe(): Pollable;
  shutdown(shutdownType: ShutdownType): void;
}
