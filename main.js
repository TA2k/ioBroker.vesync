'use strict';

/*
 * Created with @iobroker/create-adapter v2.3.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');
const axios = require('axios').default;
const Json2iob = require('json2iob');
const crypto = require('crypto');

// VeSync API version constants (from APK 5.7.80)
const VESYNC_APP_VERSION = '5.7.80';
const VESYNC_APP_BUILD = '693';
const VESYNC_APP_VERSION_FULL = `VeSync ${VESYNC_APP_VERSION} build${VESYNC_APP_BUILD}`;
const VESYNC_USER_AGENT = 'okhttp/3.12.1';
const VESYNC_APP_ID = 'eldodkfj';
const VESYNC_CLIENT_TYPE = 'vesyncApp';
const VESYNC_CLIENT_VERSION = `VeSync ${VESYNC_APP_VERSION}`;
const VESYNC_PHONE_BRAND = 'ioBroker';
const VESYNC_PHONE_OS = 'Android';

// Region-specific API URLs (from pyvesync)
const VESYNC_API_BASE_URL_US = 'https://smartapi.vesync.com';
const VESYNC_API_BASE_URL_EU = 'https://smartapi.vesync.eu';

class Vesync extends utils.Adapter {
  /**
   * @param {Partial<utils.AdapterOptions>} [options={}]
   */
  constructor(options) {
    super({
      ...options,
      name: 'vesync',
    });
    this.on('ready', this.onReady.bind(this));
    this.on('stateChange', this.onStateChange.bind(this));
    this.on('unload', this.onUnload.bind(this));
    this.deviceArray = [];

    this.json2iob = new Json2iob(this);
    this.requestClient = axios.create();
  }

  /**
   * Is called when databases are connected and adapter received configuration.
   */
  async onReady() {
    // Reset the connection indicator during startup
    this.setState('info.connection', false, true);
    if (this.config.interval < 0.5) {
      this.log.info('Set interval to minimum 0.5');
      this.config.interval = 0.5;
    }
    if (!this.config.username || !this.config.password) {
      this.log.error('Please set username and password in the instance settings');
      return;
    }
    this.terminalId = '';
    const terminalIdState = await this.getStateAsync('terminalId');

    if (terminalIdState && terminalIdState.val) {
      this.terminalId = terminalIdState.val.toString();
    } else {
      this.terminalId = crypto.randomBytes(16).toString('hex').toUpperCase();
      await this.setObjectNotExistsAsync('terminalId', {
        type: 'state',
        common: {
          name: 'terminalId unique Id for Login',
          type: 'string',
          role: 'text',
          read: true,
          write: false,
        },
        native: {},
      });
      await this.setStateAsync('terminalId', this.terminalId, true);
    }
    this.log.debug('terminalId: ' + this.terminalId);
    this.updateInterval = null;
    this.reLoginTimeout = null;
    this.refreshTokenTimeout = null;
    this.session = {};
    this.subscribeStates('*');

    this.log.info('Login to VeSync');
    await this.login();
    if (this.session.token) {
      await this.getDeviceList();
      await this.updateDevices();
      this.updateInterval = setInterval(
        async () => {
          await this.updateDevices();
        },
        this.config.interval * 60 * 1000,
      );
    }
    this.refreshTokenInterval = setInterval(
      () => {
        this.refreshToken();
      },
      12 * 60 * 60 * 1000,
    );
  }
  // Get API base URL based on region
  // Note: After login, currentRegion contains "US" or "EU" based on account location
  getApiBaseUrl() {
    const region = this.session.currentRegion || this.config.region || 'EU';
    this.log.debug(`getApiBaseUrl: currentRegion=${this.session.currentRegion}, config.region=${this.config.region}, using=${region}`);
    // US region uses smartapi.vesync.com, EU region uses smartapi.vesync.eu
    return region === 'EU' ? VESYNC_API_BASE_URL_EU : VESYNC_API_BASE_URL_US;
  }

  // Build base request body for new OAuth flow
  buildBaseRequest(method) {
    return {
      acceptLanguage: 'de',
      accountID: '',
      appVersion: VESYNC_APP_VERSION,
      appID: VESYNC_APP_ID,
      sourceAppID: VESYNC_APP_ID,
      clientInfo: VESYNC_PHONE_BRAND,
      clientType: VESYNC_CLIENT_TYPE,
      clientVersion: VESYNC_CLIENT_VERSION,
      debugMode: false,
      method: method,
      osInfo: VESYNC_PHONE_OS,
      phoneBrand: VESYNC_PHONE_BRAND,
      phoneOS: VESYNC_PHONE_OS,
      terminalId: this.terminalId,
      timeZone: 'Europe/Berlin',
      token: '',
      traceId: Date.now().toString(),
      userCountryCode: this.config.region || 'EU',
    };
  }

  // Step 1: Get Authorization Code
  async getAuthorizationCode() {
    this.log.info('Step 1: Getting authorization code...');
    const requestBody = {
      ...this.buildBaseRequest('authByPWDOrOTM'),
      email: this.config.username,
      password: crypto.createHash('md5').update(this.config.password).digest('hex'),
      authProtocolType: 'generic',
    };

    this.log.debug(`Auth request URL: ${VESYNC_API_BASE_URL_US}/globalPlatform/api/accountAuth/v1/authByPWDOrOTM`);
    this.log.debug(`Auth request body: ${JSON.stringify({ ...requestBody, password: '***' })}`);

    try {
      const response = await this.requestClient({
        method: 'post',
        url: `${VESYNC_API_BASE_URL_US}/globalPlatform/api/accountAuth/v1/authByPWDOrOTM`,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': VESYNC_USER_AGENT,
        },
        data: requestBody,
      });

      this.log.info(`Auth response code: ${response.data.code}, msg: ${response.data.msg}`);
      this.log.debug(`Auth response full: ${JSON.stringify(response.data)}`);

      if (response.data.code === 0 && response.data.result) {
        this.log.info(`Got authorization code for account: ${response.data.result.accountID}`);
        return {
          authorizeCode: response.data.result.authorizeCode,
          accountID: response.data.result.accountID,
        };
      } else {
        throw new Error(`Auth failed: ${response.data.msg} (code: ${response.data.code})`);
      }
    } catch (error) {
      if (error.response) {
        this.log.error(`Auth error response: ${JSON.stringify(error.response.data)}`);
      }
      throw error;
    }
  }

  // Step 2: Exchange Authorization Code for Token
  async loginWithAuthorizeCode(authorizeCode, accountID) {
    this.log.info('Step 2: Exchanging authorization code for token...');
    const requestBody = {
      ...this.buildBaseRequest('loginByAuthorizeCode4Vesync'),
      accountID: accountID,
      authorizeCode: authorizeCode,
      userCountryCode: this.config.region || 'EU',
    };

    this.log.debug(`Token request URL: ${VESYNC_API_BASE_URL_US}/user/api/accountManage/v1/loginByAuthorizeCode4Vesync`);
    this.log.debug(`Token request body: ${JSON.stringify(requestBody)}`);

    try {
      const response = await this.requestClient({
        method: 'post',
        url: `${VESYNC_API_BASE_URL_US}/user/api/accountManage/v1/loginByAuthorizeCode4Vesync`,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': VESYNC_USER_AGENT,
        },
        data: requestBody,
      });

      this.log.info(`Token response code: ${response.data.code}, msg: ${response.data.msg}`);
      this.log.debug(`Token response full: ${JSON.stringify(response.data)}`);

      if (response.data.code === 0 && response.data.result) {
        this.log.info(`Got token successfully, region: ${response.data.result.currentRegion}`);
        return {
          token: response.data.result.token,
          accountID: response.data.result.accountID,
          countryCode: response.data.result.countryCode,
          currentRegion: response.data.result.currentRegion,
          acceptLanguage: response.data.result.acceptLanguage || 'de',
        };
      } else {
        // Handle cross-region error - check for bizToken in response (works for all region error codes)
        this.log.debug(`Non-zero response code: ${response.data.code}, checking for bizToken...`);
        this.log.debug(`result: ${JSON.stringify(response.data.result)}`);

        // Case 1: bizToken in result - standard cross-region handling
        if (response.data.result && response.data.result.bizToken) {
          this.log.warn(`Cross-region detected (code: ${response.data.code}, msg: ${response.data.msg})`);
          this.log.info(`bizToken found, countryCode: ${response.data.result.countryCode}, currentRegion: ${response.data.result.currentRegion}`);
          return {
            crossRegion: true,
            countryCode: response.data.result.countryCode,
            currentRegion: response.data.result.currentRegion,
            bizToken: response.data.result.bizToken,
          };
        }

        // Case 2: Region conflict error with null result - try opposite region without bizToken
        // Error codes: -11261022 (access region conflict), -11260022 (cross region)
        const regionConflictCodes = [-11261022, -11260022];
        if (regionConflictCodes.includes(response.data.code) ||
            (response.data.msg && response.data.msg.toLowerCase().includes('region'))) {
          this.log.warn(`Region conflict error (code: ${response.data.code}) with no bizToken - will retry with different region`);
          // Signal to retry with opposite region
          const currentRegion = this.config.region || 'EU';
          const oppositeRegion = currentRegion === 'EU' ? 'US' : 'EU';
          return {
            regionConflict: true,
            tryRegion: oppositeRegion,
          };
        }

        this.log.error(`No bizToken in response and not a region error, login failed`);
        throw new Error(`Login failed: ${response.data.msg} (code: ${response.data.code})`);
      }
    } catch (error) {
      if (error.response) {
        this.log.error(`Token error response: ${JSON.stringify(error.response.data)}`);
      }
      throw error;
    }
  }

  // Step 2 Retry: With bizToken for cross-region
  async loginWithAuthorizeCodeRetry(authorizeCode, accountID, bizToken, countryCode) {
    this.log.info('Step 2 Retry: Exchanging with bizToken for cross-region...');
    const requestBody = {
      ...this.buildBaseRequest('loginByAuthorizeCode4Vesync'),
      accountID: accountID,
      authorizeCode: authorizeCode,
      bizToken: bizToken,
      regionChange: 'lastRegion',
      userCountryCode: countryCode,
    };

    this.log.debug(`Token retry request body: ${JSON.stringify(requestBody)}`);

    try {
      const response = await this.requestClient({
        method: 'post',
        url: `${VESYNC_API_BASE_URL_US}/user/api/accountManage/v1/loginByAuthorizeCode4Vesync`,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': VESYNC_USER_AGENT,
        },
        data: requestBody,
      });

      this.log.info(`Token retry response code: ${response.data.code}, msg: ${response.data.msg}`);
      this.log.debug(`Token retry response full: ${JSON.stringify(response.data)}`);

      if (response.data.code === 0 && response.data.result) {
        this.log.info(`Got token on retry, region: ${response.data.result.currentRegion}`);
        return {
          token: response.data.result.token,
          accountID: response.data.result.accountID,
          countryCode: response.data.result.countryCode,
          currentRegion: response.data.result.currentRegion,
          acceptLanguage: response.data.result.acceptLanguage || 'de',
        };
      } else {
        this.log.error(`Token retry failed with code: ${response.data.code}`);
        throw new Error(`Login retry failed: ${response.data.msg} (code: ${response.data.code})`);
      }
    } catch (error) {
      if (error.response) {
        this.log.error(`Token retry error response: ${JSON.stringify(error.response.data)}`);
      }
      throw error;
    }
  }

  // Step 2 Alternative: Retry with different region (no bizToken)
  async loginWithAuthorizeCodeDifferentRegion(authorizeCode, accountID, region) {
    this.log.info(`Step 2 Alt: Trying login with region: ${region}`);
    const requestBody = {
      ...this.buildBaseRequest('loginByAuthorizeCode4Vesync'),
      accountID: accountID,
      authorizeCode: authorizeCode,
      userCountryCode: region,
    };

    this.log.debug(`Token alt request body: ${JSON.stringify(requestBody)}`);

    try {
      const response = await this.requestClient({
        method: 'post',
        url: `${VESYNC_API_BASE_URL_US}/user/api/accountManage/v1/loginByAuthorizeCode4Vesync`,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': VESYNC_USER_AGENT,
        },
        data: requestBody,
      });

      this.log.info(`Token alt response code: ${response.data.code}, msg: ${response.data.msg}`);
      this.log.debug(`Token alt response full: ${JSON.stringify(response.data)}`);

      if (response.data.code === 0 && response.data.result) {
        this.log.info(`Got token with alt region, currentRegion: ${response.data.result.currentRegion}`);
        return {
          token: response.data.result.token,
          accountID: response.data.result.accountID,
          countryCode: response.data.result.countryCode,
          currentRegion: response.data.result.currentRegion,
          acceptLanguage: response.data.result.acceptLanguage || 'de',
        };
      } else {
        // If still failing with bizToken, try with that
        if (response.data.result && response.data.result.bizToken) {
          this.log.warn(`Alt region also needs bizToken, retrying...`);
          return await this.loginWithAuthorizeCodeRetry(
            authorizeCode,
            accountID,
            response.data.result.bizToken,
            response.data.result.countryCode
          );
        }
        this.log.error(`Token alt failed with code: ${response.data.code}`);
        throw new Error(`Login with alt region failed: ${response.data.msg} (code: ${response.data.code})`);
      }
    } catch (error) {
      if (error.response) {
        this.log.error(`Token alt error response: ${JSON.stringify(error.response.data)}`);
      }
      throw error;
    }
  }

  async login() {
    this.log.info(`Starting login for user: ${this.config.username}, region: ${this.config.region || 'EU'}`);
    this.log.debug(`TerminalId: ${this.terminalId}`);
    try {
      // Step 1: Get authorization code
      const authResult = await this.getAuthorizationCode();

      // Step 2: Exchange for token
      let loginResult = await this.loginWithAuthorizeCode(authResult.authorizeCode, authResult.accountID);

      // Handle cross-region with bizToken
      if (loginResult.crossRegion) {
        this.log.info(`Cross-region detected (account in ${loginResult.currentRegion}), retrying with bizToken...`);
        loginResult = await this.loginWithAuthorizeCodeRetry(
          authResult.authorizeCode,
          authResult.accountID,
          loginResult.bizToken,
          loginResult.countryCode
        );
      }

      // Handle region conflict without bizToken - retry with different region
      if (loginResult.regionConflict) {
        this.log.info(`Region conflict detected, retrying with region: ${loginResult.tryRegion}`);
        // Retry Step 2 with different region (no bizToken needed)
        loginResult = await this.loginWithAuthorizeCodeDifferentRegion(
          authResult.authorizeCode,
          authResult.accountID,
          loginResult.tryRegion
        );
      }

      this.log.info('Login successful (2-step OAuth)');
      this.log.info(`Token: ${loginResult.token ? loginResult.token.substring(0, 20) + '...' : 'undefined'}`);
      this.log.info(`AccountID: ${loginResult.accountID}, Region: ${loginResult.currentRegion}, CountryCode: ${loginResult.countryCode}`);
      this.session = {
        token: loginResult.token,
        accountID: loginResult.accountID,
        countryCode: loginResult.countryCode,
        currentRegion: loginResult.currentRegion || (loginResult.countryCode === 'DE' ? 'EU' : 'US'),
        acceptLanguage: loginResult.acceptLanguage,
      };
      this.setState('info.connection', true, true);
    } catch (error) {
      this.log.error(`Login failed: ${error.message}`);
      if (error.response) {
        this.log.error(JSON.stringify(error.response.data));
      }
    }
  }

  async getDeviceList() {
    const deviceListUrl = `${this.getApiBaseUrl()}/cloud/v2/deviceManaged/devices`;
    this.log.info(`Fetching device list from: ${deviceListUrl}`);
    await this.requestClient({
      method: 'post',
      url: deviceListUrl,
      headers: {
        tk: this.session.token,
        accountid: this.session.accountID,
        'content-type': 'application/json',
        tz: 'Europe/Berlin',
        'user-agent': 'ioBroker',
      },
      data: JSON.stringify({
        acceptLanguage: this.session.acceptLanguage,
        traceId: Date.now().toString(),
        accountID: this.session.accountID,
        appVersion: VESYNC_APP_VERSION_FULL,
        method: 'devices',
        pageNo: 1,
        pageSize: 1000,
        phoneBrand: 'ioBroker',
        phoneOS: 'ioBroker',
        debugMode: false,
        timeZone: 'Europe/Berlin',
        token: this.session.token,
      }),
    })
      .then(async (res) => {
        this.log.info(`Device list response code: ${res.data.code}, msg: ${res.data.msg}`);
        this.log.debug(`Device list response: ${JSON.stringify(res.data)}`);
        if (res.data.result && res.data.result.list) {
          this.log.info(`Found ${res.data.result.list.length} devices`);
          for (const device of res.data.result.list) {
            if (device.deviceType.startsWith('ES')) {
              this.log.info(`Found ${device.deviceType} ${device.deviceName} enable Weight and Health data fetching`);
              this.fetchHealthData = device.configModule;
              await this.extendObjectAsync('healthData', {
                type: 'channel',
                common: {
                  name: 'Health Data',
                },
                native: {},
              });
            }

            this.log.debug(JSON.stringify(device));
            let id = device.cid;
            if (!device.cid) {
              this.log.warn(`Device without cid: ${JSON.stringify(device)}. Device will be ignored`);
              id = device.deviceName;
            } else {
              this.deviceArray.push(device);
            }

            // if (device.subDeviceNo) {
            //   id += "." + device.subDeviceNo;
            // }

            const name = device.deviceName;

            await this.setObjectNotExistsAsync(id, {
              type: 'device',
              common: {
                name: name,
              },
              native: {},
            });
            await this.setObjectNotExistsAsync(id + '.remote', {
              type: 'channel',
              common: {
                name: 'Remote Controls',
              },
              native: {},
            });

            const remoteArray = [
              { command: 'Refresh', name: 'True = Refresh' },
              { command: 'setSwitch', name: 'True = Switch On, False = Switch Off' },
              { command: 'endCook', name: 'True = EndCook' },
              { command: 'setDisplay', name: 'True = On, False = Off' },
              { command: 'setChildLock', name: 'True = On, False = Off' },
              { command: 'setPurifierMode', name: 'sleep or auto', def: 'auto', type: 'string', role: 'text' },
              { command: 'setFanMode', name: 'normal, turbo, sleep, auto', def: 'normal', type: 'string', role: 'text' },
              { command: 'setFanSpeed', name: 'Fan speed level (1-12)', type: 'number', def: 1, role: 'level' },
              { command: 'setOscillation', name: 'True = On, False = Off' },
              { command: 'setBrightness', name: 'Bulb brightness (1-100)', type: 'number', def: 100, role: 'level.dimmer' },
              { command: 'setColorTemp', name: 'Color temperature (2700-6500)', type: 'number', def: 4000, role: 'level.color.temperature' },
              { command: 'setNightLight', name: 'on, off, dim or auto', def: 'off', type: 'string', role: 'text' },
              // RGB Bulb color
              { command: 'setColorHue', name: 'Hue (0-360)', type: 'number', def: 0, role: 'level.color.hue' },
              { command: 'setColorSaturation', name: 'Saturation (0-100)', type: 'number', def: 100, role: 'level.color.saturation' },
              { command: 'setColorMode', name: 'white or color', def: 'white', type: 'string', role: 'text' },
              // Dimmer switch
              { command: 'setDimmerBrightness', name: 'Dimmer brightness (0-100)', type: 'number', def: 100, role: 'level.dimmer' },
              // Thermostat
              { command: 'setTargetTemp', name: 'Target temperature', type: 'number', def: 21, role: 'level.temperature' },
              { command: 'setThermostatMode', name: 'off, heat, cool, auto', def: 'auto', type: 'string', role: 'text' },
              { command: 'setThermostatFanMode', name: 'auto, on, circulate', def: 'auto', type: 'string', role: 'text' },
              {
                command: 'startCook',
                name: 'Start Cooking',
                def: `{
                  "accountId": "${this.session.accountID}",
                  "cookTempDECP": 0,
                  "hasPreheat": 0,
                  "hasWarm": false,
                  "imageUrl": "",
                  "mode": "Chicken",
                  "readyStart": true,
                  "recipeId": 2,
                  "recipeName": "Huhn",
                  "recipeType": 3,
                  "startAct": {
                      "appointingTime": 0,
                      "cookSetTime": 780,
                      "cookTemp": 210,
                      "cookTempDECP": 0,
                      "imageUrl": "",
                      "level": 0,
                      "preheatTemp": 0,
                      "shakeTime": 0,
                      "targetTemp": 0
                  },
                  "tempUnit": "c"
              }`,
                type: 'string',
                role: 'json',
              },
              {
                command: 'cookMode',
                name: 'Start cookMode ',
                def: `{
                  "accountId": "${this.session.accountID}",
                  "appointmentTs": 0,
                  "cookSetTemp": 175,
                  "cookSetTime": 15,
                  "cookStatus": "cooking",
                  "customRecipe": "Manuell",
                  "mode": "custom",
                  "readyStart": true,
                  "recipeId": 1,
                  "recipeType": 3,
                  "tempUnit": "celsius"
              }`,
                type: 'string',
                role: 'json',
              },
              { command: 'setHumidityMode', name: 'sleep, manual or auto', def: 'auto', type: 'string', role: 'text' },
              {
                command: 'setProperty',
                name: 'setProperty like PowerSwitch',

                type: 'string',
                role: 'json',
                def: '{"powerSwitch_1":1}',
              },
              { command: 'setTargetHumidity', name: 'set Target Humidity', type: 'number', def: 65, role: 'level' },
              { command: 'setLevel-mist', name: 'set Level Mist', type: 'number', def: 10, role: 'level' },
              { command: 'setLevel-wind', name: 'set Level Wind', type: 'number', def: 10, role: 'level' },
              { command: 'setLevel-warm', name: 'set Level Warm', type: 'number', def: 10, role: 'level' },
            ];
            if (device.cid) {
              remoteArray.forEach((remote) => {
                this.extendObject(id + '.remote.' + remote.command, {
                  type: 'state',
                  common: {
                    name: remote.name || '',
                    type: remote.type || 'boolean',
                    role: remote.role || 'switch',
                    def: remote.def != null ? remote.def : false,
                    write: true,
                    read: true,
                  },
                  native: {},
                });
              });
            }
            this.json2iob.parse(id + '.general', device, { forceIndex: true });
          }
        }
      })
      .catch((error) => {
        this.log.error(error);
        error.response && this.log.error(JSON.stringify(error.response.data));
      });
  }

  async updateDevices() {
    const statusArray = [
      {
        url: `${this.getApiBaseUrl()}/cloud/v2/deviceManaged/bypassV2`,
        path: 'status',
        desc: 'Status of the device',
      },
    ];

    for (const element of statusArray) {
      for (const device of this.deviceArray) {
        // const url = element.url.replace("$id", id);

        await this.requestClient({
          method: 'post',
          url: element.url,
          headers: {
            'content-type': 'application/json',
            'user-agent': 'ioBroker',
            accept: '*/*',
          },
          data: JSON.stringify(this.deviceIdentifier(device)),
        })
          .then(async (res) => {
            this.log.debug(JSON.stringify(res.data));
            if (!res.data) {
              return;
            }
            if (res.data.code != 0) {
              if (res.data.code === -11300030) {
                this.log.info('Device ' + device.cid + ' is offline');
                return;
              }
              this.log.error(JSON.stringify(res.data));
              return;
            }
            let data = res.data.result;
            if (data.result) {
              data = data.result;
            }

            const forceIndex = true;
            const preferedArrayName = null;

            this.json2iob.parse(device.cid + '.' + element.path, data, {
              forceIndex: forceIndex,
              write: true,
              preferedArrayName: preferedArrayName,
              channelName: element.desc,
            });
            // await this.setObjectNotExistsAsync(element.path + ".json", {
            //   type: "state",
            //   common: {
            //     name: "Raw JSON",
            //     write: false,
            //     read: true,
            //     type: "string",
            //     role: "json",
            //   },
            //   native: {},
            // });
            // this.setState(element.path + ".json", JSON.stringify(data), true);
          })
          .catch((error) => {
            if (error.response) {
              if (error.response.status === 401) {
                error.response && this.log.debug(JSON.stringify(error.response.data));
                this.log.info(element.path + ' receive 401 error. Refresh Token in 60 seconds');
                this.refreshTokenTimeout && clearTimeout(this.refreshTokenTimeout);
                this.refreshTokenTimeout = setTimeout(() => {
                  this.refreshToken();
                }, 1000 * 60);

                return;
              }
            }
            this.log.error(element.url);
            this.log.error(error);
            error.response && this.log.error(JSON.stringify(error.response.data));
          });
      }
    }
    if (this.fetchHealthData) {
      await this.getHealthData();
    }
  }
  async getHealthData() {
    const statusArray = [
      {
        url: `${this.getApiBaseUrl()}/cloud/v1/user/getUserInfo`,
        path: 'userInfo',
        desc: 'User Info',
      },
      {
        url: `${this.getApiBaseUrl()}/iot/api/fitnessScale/getWeighingDataV4`,
        path: 'weightingData',
        desc: 'Weighting Data v4',
        data: {
          allData: true,
          configModule: this.fetchHealthData,
          page: 1,
          pageSize: 100,
          subUserID: null,
          uploadTimestamp: null,
          weightUnit: 'kg',
        },
      },
      {
        url: `${this.getApiBaseUrl()}/cloud/v3/user/getHealthyHomeData`,
        path: 'healthHomeData',
        desc: 'Health Home Data',
      },
      {
        url: `${this.getApiBaseUrl()}/cloud/v3/user/getAllSubUserV3`,
        path: 'subUser',
        desc: 'Sub User Information v3',
      },
    ];
    for (const status of statusArray) {
      let data = {
        method: status.url.split('/').pop(),
        debugMode: false,
        accountID: this.session.accountID,
        acceptLanguage: 'de',
        phoneOS: 'iOS16.7.2',
        clientInfo: 'iPhone 8 Plus',
        clientType: 'vesyncApp',
        clientVersion: VESYNC_APP_VERSION_FULL,
        traceId: Date.now().toString(),
        appVersion: VESYNC_APP_VERSION_FULL,
        token: this.session.token,
        terminalId: this.terminalId,
        phoneBrand: 'iPhone 8 Plus',
        userCountryCode: 'DE',
        timeZone: 'Europe/Berlin',
        configModule: this.fetchHealthData,
        isAsc: true,
        afterIndex: null,
        subUserType: 1,
        pageSize: 300,
      };
      if (status.data) {
        data = {
          context: {
            acceptLanguage: 'de',
            accountID: this.session.accountID,
            clientInfo: 'iPhone 8 Plus',
            clientType: 'vesyncApp',
            clientVersion: VESYNC_APP_VERSION_FULL,
            debugMode: false,
            method: 'getWeighingDataV4',
            osInfo: 'iOS16.7.2',
            terminalId: this.terminalId,
            timeZone: 'Europe/Berlin',
            token: this.session.token,
            traceId: '',
            userCountryCode: 'DE',
          },
          data: status.data,
        };
      }
      await this.requestClient({
        method: 'post',
        maxBodyLength: Infinity,
        url: status.url,
        headers: {
          accept: '*/*',
          'content-type': 'application/json',
          'user-agent': 'ioBroker',
          'accept-language': 'de-DE;q=1.0',
        },
        data: data,
      })
        .then(async (res) => {
          this.log.debug(JSON.stringify(res.data));
          if (!res.data) {
            return;
          }
          if (res.data.code != 0) {
            this.log.error(status.url);
            if (res.data.code === -11300030) {
              //eslint-disable-next-line
              this.log.info('Device ' + device.cid + ' is offline');
              return;
            }
            this.log.error(JSON.stringify(res.data));
            return;
          }
          this.json2iob.parse('healthData.' + status.path, res.data.result, { preferedArrayName: 'nickname' });
        })
        .catch((error) => {
          this.log.error(status.url);
          this.log.error(error);
          error.response && this.log.error(JSON.stringify(error.response.data));
        });
    }
  }
  deviceIdentifier(device) {
    if (device.deviceType.startsWith('CS')) {
      return {
        acceptLanguage: 'de',
        accountID: this.session.accountID,
        appVersion: VESYNC_APP_VERSION_FULL,
        cid: device.cid,
        configModule: device.configModule,
        debugMode: false,
        jsonCmd: {
          getStatus: 'status',
        },
        method: 'bypass',
        phoneBrand: 'iPhone 8 Plus',
        phoneOS: 'iOS 14.8',
        pid: '8t8op7pcvzlsbosm',
        timeZone: 'Europe/Berlin',
        token: this.session.token,
        traceId: Date.now().toString(),
        userCountryCode: 'DE',
        uuid: device.uuid,
      };
    }

    if (device.deviceType.startsWith('CA')) {
      return {
        acceptLanguage: 'de',
        accountID: this.session.accountID,
        appVersion: VESYNC_APP_VERSION_FULL,
        cid: device.cid,
        configModule: device.configModule,
        debugMode: false,
        deviceRegion: 'EU',
        method: 'bypassV2',
        payload: {
          data: {},
          method: 'getAirfryerStatus',
          source: 'APP',
        },
        phoneBrand: 'iPhone 8 Plus',
        phoneOS: 'iOS 14.8',
        timeZone: 'Europe/Berlin',
        token: this.session.token,
        traceId: Date.now().toString(),
        userCountryCode: 'DE',
      };
    }
    let method = 'getHumidifierStatus';
    let data = {};
    // Humidifiers
    if (
      device.deviceType.includes('LUH-') ||
      device.deviceType.includes('Classic') ||
      device.deviceType.includes('LV600') ||
      device.deviceType.includes('Dual') ||
      device.deviceType.includes('LEH-')
    ) {
      method = 'getHumidifierStatus';
    }
    // Purifiers
    if (device.deviceType.includes('LAP-') || device.deviceType.includes('Core') || device.deviceType.includes('LV-')) {
      method = 'getPurifierStatus';
    }
    // Fans
    if (device.deviceType.includes('LTF-') || device.deviceType.includes('LPF-')) {
      method = 'getFanStatus';
    }
    // Outlets
    if (device.deviceType.startsWith('WHOGPLUG') || device.deviceType.startsWith('WYZYOG') ||
        device.deviceType.startsWith('ESW') || device.deviceType.startsWith('ESO') ||
        device.deviceType.startsWith('wifi-switch')) {
      method = 'getOutletStatus';
    }
    // Switches
    if (device.deviceType.startsWith('ESWL') || device.deviceType.startsWith('ESWD')) {
      method = 'getSwitchStatus';
    }
    // Bulbs
    if (device.deviceType.startsWith('ESL') || device.deviceType.startsWith('XYD')) {
      method = 'getLightStatus';
    }
    // Thermostats
    if (device.deviceType.startsWith('LTM-')) {
      method = 'getThermostatStatus';
    }
    // Smart Plugs with property method
    if (device.deviceType.startsWith('BS') || device.deviceType.startsWith('BSDOG')) {
      method = 'getProperty';
      data = {
        properties: [
          'powerSwitch_1',
          'realTimeVoltage',
          'realTimePower',
          'electricalEnergy',
          'protectionStatus',
          'voltageUpperThreshold',
          'currentUpperThreshold',
          'voltageUnderThreshold',
          'scheduleNum',
        ],
      };
    }
    return {
      accountID: this.session.accountID,
      method: 'bypassV2',
      deviceRegion: 'EU',
      phoneOS: 'iOS 14.8',
      timeZone: 'Europe/Berlin',
      debugMode: false,
      cid: device.cid,
      payload: {
        method: method,
        data: data,
        source: 'APP',
      },
      configModule: '',
      traceId: Date.now(),
      phoneBrand: 'iPhone 8 Plus',
      acceptLanguage: 'de',
      appVersion: VESYNC_APP_VERSION_FULL,
      userCountryCode: 'DE',
      token: this.session.token,
    };
  }

  async refreshToken() {
    this.log.debug('Refresh token');
    await this.login();
  }

  /**
   * Is called when adapter shuts down - callback has to be called under any circumstances!
   * @param {() => void} callback
   */
  onUnload(callback) {
    try {
      this.setState('info.connection', false, true);
      this.refreshTimeout && clearTimeout(this.refreshTimeout);
      this.reLoginTimeout && clearTimeout(this.reLoginTimeout);
      this.refreshTokenTimeout && clearTimeout(this.refreshTokenTimeout);
      this.updateInterval && clearInterval(this.updateInterval);
      this.refreshTokenInterval && clearInterval(this.refreshTokenInterval);
      callback();
    } catch (e) {
      this.log.error(e);
      callback();
    }
  }

  /**
   * Is called if a subscribed state changes
   * @param {string} id
   * @param {ioBroker.State | null | undefined} state
   */
  async onStateChange(id, state) {
    if (state) {
      if (!state.ack) {
        const deviceId = id.split('.')[2];
        let command = id.split('.')[4];
        const type = command.split('-')[1];
        command = command.split('-')[0];

        if (id.split('.')[4] === 'Refresh') {
          this.updateDevices();
          return;
        }

        if (id.split('.')[4] === 'cookMode') {
          await this.requestClient({
            method: 'post',
            url: `${this.getApiBaseUrl()}/cloud/v2/deviceManaged/bypassV2`,
            headers: {
              accept: '*/*',
              'content-type': 'application/json',
              'user-agent': VESYNC_USER_AGENT,
              'accept-language': 'de-DE;q=1.0, uk-DE;q=0.9, en-DE;q=0.8',
            },
            data: JSON.stringify({
              traceId: Date.now(),
              debugMode: false,
              acceptLanguage: 'de',
              cid: deviceId,
              timeZone: 'Europe/Berlin',
              accountID: this.session.accountID,
              jsonCmd: {
                cookMode: JSON.parse(state.val),
              },
              method: 'bypass',
              appVersion: VESYNC_APP_VERSION_FULL,
              deviceRegion: 'EU',
              phoneBrand: 'iPhone 8 Plus',
              token: this.session.token,
              phoneOS: 'iOS 14.8',
              configModule: '',
              userCountryCode: 'DE',
            }),
          })
            .then((res) => {
              this.log.info(JSON.stringify(res.data));
            })
            .catch(async (error) => {
              this.log.error(error);
              error.response && this.log.error(JSON.stringify(error.response.data));
            });
        } else {
          let data;
          data = {
            enabled: state.val,
            id: 0,
          };
          if (command === 'setTargetHumidity') {
            data = {
              target_humidity: state.val,
            };
          }
          if (command === 'setDisplay') {
            data = {
              state: state.val,
            };
          }
          if (command === 'setPurifierMode' || command === 'setHumidityMode') {
            data = {
              mode: state.val,
            };
          }
          if (command === 'setChildLock') {
            data = {
              child_lock: state.val,
            };
          }
          if (command === 'setLevel') {
            data = {
              level: state.val,
              type: type,
              id: 0,
            };
          }
          if (command === 'startCook') {
            try {
              data = JSON.parse(state.val);
            } catch (error) {
              this.log.error(error);
            }
          }
          if (command === 'endCook') {
            data = {};
          }
          if (command === 'setProperty') {
            try {
              data = JSON.parse(state.val);
            } catch (error) {
              this.log.error(error);
            }
          }
          // Fan commands
          if (command === 'setFanMode') {
            data = {
              mode: state.val,
            };
          }
          if (command === 'setFanSpeed') {
            data = {
              level: state.val,
              id: 0,
            };
            command = 'setLevel';
          }
          if (command === 'setOscillation') {
            data = {
              enabled: state.val,
            };
          }
          // Bulb commands
          if (command === 'setBrightness') {
            data = {
              brightness: state.val,
            };
          }
          if (command === 'setColorTemp') {
            data = {
              colorTemp: state.val,
            };
          }
          // Nightlight
          if (command === 'setNightLight') {
            data = {
              night_light: state.val,
            };
          }
          // RGB Bulb color
          if (command === 'setColorHue') {
            data = {
              hue: state.val,
            };
            command = 'setLightColor';
          }
          if (command === 'setColorSaturation') {
            data = {
              saturation: state.val,
            };
            command = 'setLightColor';
          }
          if (command === 'setColorMode') {
            data = {
              colorMode: state.val,
            };
            command = 'setLightColorMode';
          }
          // Dimmer switch
          if (command === 'setDimmerBrightness') {
            data = {
              brightness: state.val,
            };
            command = 'setBrightness';
          }
          // Thermostat
          if (command === 'setTargetTemp') {
            data = {
              targetTemp: state.val,
            };
          }
          if (command === 'setThermostatMode') {
            const modeMap = { off: 0, heat: 1, cool: 2, auto: 3 };
            data = {
              workMode: modeMap[state.val] !== undefined ? modeMap[state.val] : 3,
            };
            command = 'setThermostatWorkMode';
          }
          if (command === 'setThermostatFanMode') {
            const fanModeMap = { auto: 1, on: 2, circulate: 3 };
            data = {
              fanMode: fanModeMap[state.val] !== undefined ? fanModeMap[state.val] : 1,
            };
            command = 'setThermostatFanMode';
          }
          await this.requestClient({
            method: 'post',
            url: `${this.getApiBaseUrl()}/cloud/v2/deviceManaged/bypassV2`,
            headers: {
              accept: '*/*',
              'content-type': 'application/json',
              'user-agent': VESYNC_USER_AGENT,
              'accept-language': 'de-DE;q=1.0, uk-DE;q=0.9, en-DE;q=0.8',
            },
            data: JSON.stringify({
              traceId: Date.now(),
              debugMode: false,
              acceptLanguage: 'de',
              method: 'bypassV2',
              cid: deviceId,
              timeZone: 'Europe/Berlin',
              accountID: this.session.accountID,
              payload: {
                data: data,
                source: 'APP',
                method: command,
              },
              appVersion: VESYNC_APP_VERSION_FULL,
              deviceRegion: 'EU',
              phoneBrand: 'iPhone 8 Plus',
              token: this.session.token,
              phoneOS: 'iOS 14.8',
              configModule: '',
              userCountryCode: 'DE',
            }),
          })
            .then((res) => {
              this.log.info(JSON.stringify(res.data));
            })
            .catch(async (error) => {
              this.log.error(error);
              error.response && this.log.error(JSON.stringify(error.response.data));
            });
        }
        this.refreshTimeout = setTimeout(async () => {
          this.log.info('Update devices');
          await this.updateDevices();
        }, 10 * 1000);
      } else {
        const resultDict = {
          auto_target_humidity: 'setTargetHumidity',
          enabled: 'setSwitch',
          display: 'setDisplay',
          child_lock: 'setChildLock',
          level: 'setLevel-wind',
          mode: 'setPurifierMode',
        };
        const idArray = id.split('.');
        const stateName = idArray[idArray.length - 1];
        const deviceId = id.split('.')[2];
        if (resultDict[stateName]) {
          const value = state.val;
          await this.setStateAsync(deviceId + '.remote.' + resultDict[stateName], value, true);
        }
      }
    }
  }
}

if (require.main !== module) {
  // Export the constructor in compact mode
  /**
   * @param {Partial<utils.AdapterOptions>} [options={}]
   */
  module.exports = (options) => new Vesync(options);
} else {
  // otherwise start the instance directly
  new Vesync();
}
