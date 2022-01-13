import axios, { AxiosRequestConfig } from 'axios';
import { EventEmitter } from 'events';
import fs from 'fs';
import https from 'https';
import { performance } from 'perf_hooks';

import { CurlAuth, CurlEnums, CurlInfoDebug } from './curl-enum/Curl';

class NotCurl extends EventEmitter {
  reqOptions: AxiosRequestConfig;
  sslVerify: boolean;
  writeListener: any;
  responseBodyBytes: number;
  debugListener: any;
  elapsedTime: number;
  postData: any;
  followRedirects: boolean;
  caBundle: string | Buffer | (string | Buffer)[] | undefined;
  username: any;
  password: any;
  httpAuth: any;

  constructor() {
    super();
    this.reqOptions = { headers: {} };
    this.sslVerify = true;
    this.responseBodyBytes = 0;
    this.elapsedTime = 0;
    this.postData = '';
  }
  static option = CurlEnums.option;
  static info = CurlEnums.info;
  static getVersion() {
    return 'axios/0.21.1';
  }

  getInfo(opt) {
    const name = Object.keys(CurlEnums.info).find(name => CurlEnums.info[name] === opt);
    if (name === 'SIZE_DOWNLOAD') return this.responseBodyBytes;
    if (name === 'TOTAL_TIME') return this.elapsedTime;
    if (name === 'EFFECTIVE_URL') return this.reqOptions.url;

    console.log('unhandled getInfo', opt, name);
    return undefined;
  }
  setOpt(opt: any, val: any) {
    const name = Object.keys(CurlEnums.option).find(name => CurlEnums.option[name] === opt);

    switch (name) {
      case 'MAXREDIRS':
        this.reqOptions.maxRedirects = val;
        break;
      case 'FOLLOWLOCATION':
        this.followRedirects = val;
        break;
      case 'PROXY':
        if (val === '') this.reqOptions.proxy = false;
        else {
          const { hostname, port } = new URL(val);
          this.reqOptions.proxy = {
            host: hostname,
            port: parseInt(port, 10),
          };
        }
        break;
      case 'HTTPAUTH':
        this.httpAuth = val;
        break;
      case 'USERNAME':
        this.username = val;
        break;
      case 'PASSWORD':
        this.password = val;
        break;
      case 'NOBODY':
        this.reqOptions.method = 'HEAD';
        break;
      case 'POST':
        this.reqOptions.method = 'POST';
        break;
      case 'CUSTOMREQUEST':
        this.reqOptions.method = val;
        break;
      case 'TIMEOUT_MS':
        this.reqOptions.timeout = val;
        break;
      case 'SSL_VERIFYHOST':
        this.sslVerify = !!val;
        break;
      case 'SSL_VERIFYPEER':
        // NOTE: same as above in nodejs
        break;
      case 'CAINFO':
        // NOTE: needs testing
        this.caBundle = fs.readFileSync(val);
        break;
      case 'POSTFIELDS':
        this.reqOptions.data = val;
        break;
      case 'URL':
        this.reqOptions.url = val;
        break;
      case 'WRITEFUNCTION':
        this.writeListener = val;
        break;
      case 'DEBUGFUNCTION':
        this.debugListener = val;
        break;
      case 'HTTPHEADER':
        // TODO
        // val.map(x => {
        //   const name = x.split(':')[0];
        //   this.reqOptions.headers[name] = x.split(':')[1].trim();
        // });
        break;
      case 'USERAGENT':
        this.reqOptions.headers['User-Agent'] = val;
        break;
      case 'COOKIELIST':
        this.reqOptions.headers['Set-Cookie'] = val;
        break;
      case 'COOKIE':
        // TODO: append to set-cookie?
        break;
      default:
        console.log('unhandled option', opt, name, val);
    }
  }
  enable() {
    // ignore this, as its only used for disabling auto parsing of headers and body
  }
  perform() {
    // NOTE: disable follow redirects https://github.com/axios/axios/pull/307/files#diff-586c04c24
    if (!this.followRedirects) this.reqOptions.maxRedirects = 0;
    const agentConfig: https.AgentOptions = {
      rejectUnauthorized: this.sslVerify,
      ca: this.caBundle,
    };
    // TODO: digest, ntlm, netrc etc
    if (this.httpAuth === CurlAuth.Basic) {
      this.reqOptions.auth = { username: this.username, password: this.password };
    }
    this.reqOptions.httpsAgent = new https.Agent(agentConfig);
    this.reqOptions.adapter = global.require('axios/lib/adapters/http'),
    this.reqOptions.responseType = 'stream';
    this.reqOptions.validateStatus = () => true;
    const startTime = performance.now();
    console.log('perform', this.reqOptions);
    axios.request(this.reqOptions)
      .then(response => {
        response.data.on('data', chunk => {
          this.responseBodyBytes += chunk.length;
          this.writeListener(chunk);
          // IDEA: CurlInfoDebug could be replaced with a mimetype/content-type check
          this.debugListener(CurlInfoDebug.DataIn, chunk);
        });
        response.data.on('end', () => {
          console.log('No more data in response.', response.config);
          this.elapsedTime = performance.now() - startTime;
          const rawHeaders = [{
            version: 'HTTP1.1', // TODO: what?
            code: response.status,
            reason: response.statusText,
            headers: Object.entries(response.headers).map(([name, value]) => ({ name, value })),
          }];
          this.emit('end', null, null, rawHeaders);
        });
      }).catch(e => this.emit('error', e));
  }
  close() {
    // TODO: maybe reset state here?
    console.log('close');
    this.removeAllListeners('end');
    this.removeAllListeners('error');
  }
}

export { NotCurl as Curl };
export { CurlAuth, CurlCode, CurlHttpVersion, CurlInfoDebug, CurlNetrc } from './curl-enum/Curl';
