export const networkConfig = { rpcAddrs: [process.env.AGORIC_RPC || 'http://127.0.0.1:26657'], chainName: process.env.AGORIC_NET };
/* eslint-disable @jessie.js/no-nested-await */
/* global Buffer, fetch, process */

import { makeMarshal } from '@endo/marshal';
import { Far } from '@endo/far';

/**
 * @typedef {{boardId: string, iface: string}} RpcRemote
 */

export const networkConfigUrl = agoricNetSubdomain =>
  `https://${agoricNetSubdomain}.agoric.net/network-config`;
export const rpcUrl = agoricNetSubdomain =>
  `https://${agoricNetSubdomain}.rpc.agoric.net:443`;

/**
 * @typedef {{ rpcAddrs: string[], chainName: string }} MinimalNetworkConfig
 */

/**
 *  @param {string} str
 * @returns {Promise<MinimalNetworkConfig>}
 */
const fromAgoricNet = str => {
  const [netName, chainName] = str.split(',');
  if (chainName) {
    return Promise.resolve({ chainName, rpcAddrs: [rpcUrl(netName)] });
  }
  return fetch(networkConfigUrl(netName)).then(res => res.json());
};

/** @type {MinimalNetworkConfig} */
// console.warn('networkConfig', networkConfig);

/**
 *
 * @param {object} powers
 * @param {typeof window.fetch} powers.fetch
 */
export const makeVStorage = powers => {
  const getJSON = path => {
    const url = networkConfig.rpcAddrs[0] + path;
    // console.warn('fetching', url);
    return powers.fetch(url, { keepalive: true }).then(res => res.json());
  };

  return {
    // height=0 is the same as omitting height and implies the highest block
    url: (path = 'published', { kind = 'children', height = 0 } = {}) =>
      `/abci_query?path=%22/custom/vstorage/${kind}/${path}%22&height=${height}`,
    decode({ result: { response } }) {
      const { code } = response;
      if (code !== 0) {
        throw response;
      }
      const { value } = response;
      return Buffer.from(value, 'base64').toString();
    },
    /**
     *
     * @param {string} path
     * @returns {Promise<string>} latest vstorage value at path
     */
    async readLatest(path = 'published') {
      const raw = await getJSON(this.url(path, { kind: 'data' }));
      return this.decode(raw);
    },
    async keys(path = 'published') {
      const raw = await getJSON(this.url(path, { kind: 'children' }));
      return JSON.parse(this.decode(raw)).children;
    },
    /**
     * @param {string} path
     * @param {number} [height] default is highest
     * @returns {Promise<{blockHeight: number, values: string[]}>}
     */
    async readAt(path, height = undefined) {
      const raw = await getJSON(this.url(path, { kind: 'data', height }));
      const txt = this.decode(raw);
      /** @type {{ value: string }} */
      const { value } = JSON.parse(txt);
      return JSON.parse(value);
    },
    /**
     * Read values going back as far as available
     *
     * @param {string} path
     * @returns {Promise<string[]>}
     */
    async readFully(path) {
      const parts = [];
      // undefined the first iteration, to query at the highest
      let blockHeight;
      do {
        console.debug('READING', { blockHeight });
        let values;
        try {
          // eslint-disable-next-line no-await-in-loop
          ({ blockHeight, values } = await this.readAt(
            path,
            blockHeight && blockHeight - 1,
          ));
          console.debug('readAt returned', { blockHeight });
        } catch (err) {
          if ('log' in err && err.log.match(/unknown request/)) {
            console.error(err);
            break;
          }
          throw err;
        }
        parts.push(values);
        console.debug('PUSHED', values);
        console.debug('NEW', { blockHeight });
      } while (blockHeight > 0);
      return parts.flat();
    },
  };
};
/** @typedef {ReturnType<typeof makeVStorage>} VStorage */

/**
 * @param {*} slotInfo
 * @returns {BoardRemote}
 */
export const makeBoardRemote = ({ boardId, iface }) => {
  const nonalleged =
    iface && iface.length ? iface.slice('Alleged: '.length) : '';
  return Far(`BoardRemote${nonalleged}`, { getBoardId: () => boardId });
};

export const boardValToSlot = val => {
  if ('getBoardId' in val) {
    return val.getBoardId();
  }
  Fail`unknown obj in boardSlottingMarshaller.valToSlot ${val}`;
};

/**
 * A marshaller which can serialize getBoardId() -bearing
 * Remotables. This allows the caller to pick their slots. The
 * deserializer is configurable: the default cannot handle
 * Remotable-bearing data.
 *
 * @param {(slot: string, iface: string) => any} [slotToVal]
 * @returns {import('@endo/marshal').Marshal<string>}
 */
export const boardSlottingMarshaller = (slotToVal = undefined) => {
  return makeMarshal(boardValToSlot, slotToVal, {
    serializeBodyFormat: 'smallcaps',
  });
};

export const makeFromBoard = () => {
  const cache = new Map();
  const convertSlotToVal = (boardId, iface) => {
    if (cache.has(boardId)) {
      return cache.get(boardId);
    }
    const val = makeBoardRemote({ boardId, iface });
    cache.set(boardId, val);
    return val;
  };
  return harden({ convertSlotToVal });
};
/** @typedef {ReturnType<typeof makeFromBoard>} IdMap */

export const storageHelper = {
  /** @param { string } txt */
  parseCapData: txt => {
    assert(typeof txt === 'string', typeof txt);
    /** @type {{ value: string }} */
    const { value } = JSON.parse(txt);
    const specimen = JSON.parse(value);
    const { blockHeight, values } = specimen;
    assert(values, `empty values in specimen ${value}`);
    const capDatas = storageHelper.parseMany(values);
    return { blockHeight, capDatas };
  },
  /**
   * @param {string} txt
   * @param {IdMap} ctx
   */
  unserializeTxt: (txt, ctx) => {
    const { capDatas } = storageHelper.parseCapData(txt);
    return capDatas.map(capData =>
      boardSlottingMarshaller(ctx.convertSlotToVal).unserialize(capData),
    );
  },
  /** @param {string[]} capDataStrings array of stringified capData */
  parseMany: capDataStrings => {
    assert(capDataStrings && capDataStrings.length);
    /** @type {{ body: string, slots: string[] }[]} */
    const capDatas = capDataStrings.map(s => JSON.parse(s));
    for (const capData of capDatas) {
      assert(typeof capData === 'object' && capData !== null);
      assert('body' in capData && 'slots' in capData);
      assert(typeof capData.body === 'string');
      assert(Array.isArray(capData.slots));
    }
    return capDatas;
  },
};
harden(storageHelper);

/**
 * @param {IdMap} ctx
 * @param {VStorage} vstorage
 * @returns {Promise<{ brand: Record<string, RpcRemote>, instance: Record<string, RpcRemote>, reverse: Record<string, string> }>}
 */
export const makeAgoricNames = async (ctx, vstorage) => {
  const reverse = {};
  const entries = await Promise.all(
    ['brand', 'instance', 'vbankAsset'].map(async kind => {
      const content = await vstorage.readLatest(
        `published.agoricNames.${kind}`,
      );
      /** @type {Array<[string, import('@agoric/vats/tools/board-utils.js').BoardRemote]>} */
      const parts = storageHelper.unserializeTxt(content, ctx).at(-1);
      for (const [name, remote] of parts) {
        if ('getBoardId' in remote) {
          reverse[remote.getBoardId()] = name;
        }
      }
      return [kind, Object.fromEntries(parts)];
    }),
  );
  return { ...Object.fromEntries(entries), reverse };
};

export const makeRpcUtils = async ({ fetch }) => {
  const vstorage = makeVStorage({ fetch });
  const fromBoard = makeFromBoard();
  const agoricNames = await makeAgoricNames(fromBoard, vstorage);

  return { vstorage, fromBoard, agoricNames };
};
