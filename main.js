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
      url: 'https://smartapi.vesync.com/cloud/v2/user/loginV2',
      headers: {
        Host: 'smartapi.vesync.com',
        accept: '*/*',
        'content-type': 'application/json',
        'user-agent': 'VeSync/4.1.10 (iPhone; iOS 14.8; Scale/3.00)',
        'accept-language': 'de-DE;q=1, uk-DE;q=0.9, en-DE;q=0.8',
      },
      data: JSON.stringify({
        userType: '1',
        phoneOS: 'ioBroker',
        acceptLanguage: 'de',
        phoneBrand: 'ioBroker',
        password: crypto.createHash('md5').update(this.config.password).digest('hex'),
        timeZone: 'Europe/Berlin',
        token: '',
        traceId: '',
        appVersion: 'VeSync 4.1.10 build2',
        accountID: '',
        email: this.config.username,
        method: 'loginV2',
      }),
    })
      .then((res) => {
        this.log.debug(JSON.stringify(res.data));
        if (res.data.result) {
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
        acceptLanguage: 'de',
        accountID: this.session.accountID,
        appVersion: '1.1',
        method: 'devices',
        pageNo: 1,
        pageSize: 1000,
        phoneBrand: 'ioBroker',
        phoneOS: 'ioBroker',
        timeZone: 'Europe/Berlin',
        token: this.session.token,
        traceId: '',
      }),
    })
      .then(async (res) => {
        this.log.debug(JSON.stringify(res.data));
        if (res.data.result && res.data.result.list) {
          this.log.info(`Found ${res.data.result.list.length} devices`);
          for (const device of res.data.result.list) {
            if (!device.cid) {
              this.log.warn(`Device without cid: ${JSON.stringify(device)}. Device will be ignored`);
              continue;
            }
            this.log.debug(JSON.stringify(device));
            const id = device.cid;

            // if (device.subDeviceNo) {
            //   id += "." + device.subDeviceNo;
            // }

            this.deviceArray.push(device);
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
            remoteArray.forEach((remote) => {
              this.setObjectNotExists(id + '.remote.' + remote.command, {
                type: 'state',
                common: {
                  name: remote.name || '',
                  type: remote.type || 'boolean',
                  role: remote.role || 'button',
                  def: remote.def != null ? remote.def : false,
                  write: true,
                  read: true,
                },
                native: {},
              });
            });
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
