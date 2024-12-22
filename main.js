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
  async login() {
    await this.requestClient({
      method: 'post',
      url: 'https://smartapi.vesync.com/cloud/v1/user/login',
      headers: {
        accept: '*/*',
        'content-type': 'application/json',
        'user-agent': 'VeSync/5.0.50 (com.etekcity.vesyncPlatform; build:16; iOS 16.7.2) Alamofire/5.2.1',
        'accept-language': 'de-DE;q=1.0',
      },
      data: {
        timeZone: 'Europe/Berlin',
        acceptLanguage: 'de',
        appVersion: '2.5.1',
        phoneBrand: 'SM N9005',
        phoneOS: 'Android',
        traceId: Date.now().toString(),
        devToken: '',
        userType: '1',
        method: 'login',
        email: this.config.username,
        password: crypto.createHash('md5').update(this.config.password).digest('hex'),
      },
    })
      .then((res) => {
        this.log.debug(JSON.stringify(res.data));
        if (res.data.result) {
          this.log.info('Login successful');
          this.session = res.data.result;
          this.setState('info.connection', true, true);
        } else {
          this.log.error(JSON.stringify(res.data));
        }
      })
      .catch((error) => {
        this.log.error(error);
        error.response && this.log.error(JSON.stringify(error.response.data));
      });
  }

  async getDeviceList() {
    await this.requestClient({
      method: 'post',
      url: 'https://smartapi.vesync.com/cloud/v2/deviceManaged/devices',
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
        appVersion: 'VeSync 5.1.40 build9',
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
        this.log.debug(JSON.stringify(res.data));
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
        url: 'https://smartapi.vesync.com/cloud/v2/deviceManaged/bypassV2',
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
        url: 'https://smartapi.vesync.com/cloud/v1/user/getUserInfo',
        path: 'userInfo',
        desc: 'User Info',
      },
      {
        url: 'https://smartapi.vesync.com/iot/api/fitnessScale/getWeighingDataV4',
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
        url: 'https://smartapi.vesync.com/cloud/v3/user/getHealthyHomeData',
        path: 'healthHomeData',
        desc: 'Health Home Data',
      },
      {
        url: 'https://smartapi.vesync.com/cloud/v3/user/getAllSubUserV3',
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
        clientVersion: 'VeSync 5.0.50 build16',
        traceId: Date.now().toString(),
        appVersion: 'VeSync 5.0.50 build16',
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
            clientVersion: 'VeSync 5.0.50 build16',
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
        appVersion: 'VeSync 4.1.52 build4',
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
        appVersion: 'VeSync 4.2.20 build12',
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
    if (
      device.deviceType.includes('LUH-') ||
      device.deviceType.includes('Classic') ||
      device.deviceType.includes('LV600') ||
      device.deviceType.includes('Dual')
    ) {
      method = 'getHumidifierStatus';
    }
    if (device.deviceType.includes('LAP-') || device.deviceType.includes('Core') || device.deviceType.includes('LV-')) {
      method = 'getPurifierStatus';
    }
    if (device.deviceType.includes('LAP-') || device.deviceType.includes('Core') || device.deviceType.includes('LV-')) {
      method = 'getPurifierStatus';
    }
    if (device.deviceType.startsWith('BS')) {
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
      appVersion: 'VeSync 4.1.10 build2',
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
            url: 'https://smartapi.vesync.com/cloud/v2/deviceManaged/bypassV2',
            headers: {
              Host: 'smartapi.vesync.com',
              accept: '*/*',
              'content-type': 'application/json',
              'user-agent': 'VeSync/4.1.10 (com.etekcity.vesyncPlatform; build:2; iOS 14.8.0) Alamofire/5.2.1',
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
              appVersion: 'VeSync 4.1.10 build2',
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
          await this.requestClient({
            method: 'post',
            url: 'https://smartapi.vesync.com/cloud/v2/deviceManaged/bypassV2',
            headers: {
              Host: 'smartapi.vesync.com',
              accept: '*/*',
              'content-type': 'application/json',
              'user-agent': 'VeSync/4.1.10 (com.etekcity.vesyncPlatform; build:2; iOS 14.8.0) Alamofire/5.2.1',
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
              appVersion: 'VeSync 4.1.10 build2',
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
