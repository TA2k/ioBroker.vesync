"use strict";

/*
 * Created with @iobroker/create-adapter v2.3.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require("@iobroker/adapter-core");
const axios = require("axios");
const Json2iob = require("./lib/json2iob");
const crypto = require("crypto");

class Vesync extends utils.Adapter {
  /**
   * @param {Partial<utils.AdapterOptions>} [options={}]
   */
  constructor(options) {
    super({
      ...options,
      name: "vesync",
    });
    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("unload", this.onUnload.bind(this));
    this.deviceArray = [];

    this.json2iob = new Json2iob(this);
    this.requestClient = axios.create();
  }

  /**
   * Is called when databases are connected and adapter received configuration.
   */
  async onReady() {
    // Reset the connection indicator during startup
    this.setState("info.connection", false, true);
    if (this.config.interval < 0.5) {
      this.log.info("Set interval to minimum 0.5");
      this.config.interval = 0.5;
    }
    if (!this.config.username || !this.config.password) {
      this.log.error("Please set username and password in the instance settings");
      return;
    }

    this.updateInterval = null;
    this.reLoginTimeout = null;
    this.refreshTokenTimeout = null;
    this.session = {};
    this.subscribeStates("*");

    this.log.info("Login to VeSync");
    await this.login();
    if (this.session.token) {
      await this.getDeviceList();
      await this.updateDevices();
      this.updateInterval = setInterval(async () => {
        await this.updateDevices();
      }, this.config.interval * 60 * 1000);
    }
    this.refreshTokenInterval = setInterval(() => {
      this.refreshToken();
    }, (this.session.expires_in || 3600) * 1000);
  }
  async login() {
    await this.requestClient({
      method: "post",
      url: "https://smartapi.vesync.com/cloud/v2/user/loginV2",
      headers: {
        Host: "smartapi.vesync.com",
        accept: "*/*",
        "content-type": "application/json",
        "user-agent": "VeSync/4.1.10 (iPhone; iOS 14.8; Scale/3.00)",
        "accept-language": "de-DE;q=1, uk-DE;q=0.9, en-DE;q=0.8",
      },
      data: JSON.stringify({
        userType: "1",
        phoneOS: "ioBroker",
        acceptLanguage: "de",
        phoneBrand: "ioBroker",
        password: crypto.createHash("md5").update(this.config.password).digest("hex"),
        timeZone: "Europe/Berlin",
        token: "",
        traceId: "",
        appVersion: "VeSync 4.1.10 build2",
        accountID: "",
        email: this.config.username,
        method: "loginV2",
      }),
    })
      .then((res) => {
        this.log.debug(JSON.stringify(res.data));
        if (res.data.result) {
          this.session = res.data.result;
          this.setState("info.connection", true, true);
        }
      })
      .catch((error) => {
        this.log.error(error);
        error.response && this.log.error(JSON.stringify(error.response.data));
      });
  }

  async getDeviceList() {
    await this.requestClient({
      method: "post",
      url: "https://smartapi.vesync.com/cloud/v2/deviceManaged/devices",
      headers: {
        tk: this.session.token,
        accountid: this.session.accountID,
        "content-type": "application/json",
        tz: "Europe/Berlin",
        "user-agent": "ioBroker",
      },
      data: JSON.stringify({
        acceptLanguage: "de",
        accountID: this.session.accountID,
        appVersion: "1.1",
        method: "devices",
        pageNo: 1,
        pageSize: 1000,
        phoneBrand: "ioBroker",
        phoneOS: "ioBroker",
        timeZone: "Europe/Berlin",
        token: this.session.token,
        traceId: "",
      }),
    })
      .then(async (res) => {
        this.log.debug(JSON.stringify(res.data));
        if (res.data.result && res.data.result.list) {
          this.log.info(`Found ${res.data.result.list.length} devices`);
          for (const device of res.data.result.list) {
            this.log.debug(JSON.stringify(device));
            const id = device.cid;
            // if (device.subDeviceNo) {
            //   id += "." + device.subDeviceNo;
            // }

            this.deviceArray.push(device);
            const name = device.deviceName;

            await this.setObjectNotExistsAsync(id, {
              type: "device",
              common: {
                name: name,
              },
              native: {},
            });
            await this.setObjectNotExistsAsync(id + ".remote", {
              type: "channel",
              common: {
                name: "Remote Controls",
              },
              native: {},
            });

            const remoteArray = [{ command: "Refresh", name: "True = Refresh" }];
            remoteArray.forEach((remote) => {
              this.setObjectNotExists(id + ".remote." + remote.command, {
                type: "state",
                common: {
                  name: remote.name || "",
                  type: remote.type || "boolean",
                  role: remote.role || "boolean",
                  def: remote.def || false,
                  write: true,
                  read: true,
                },
                native: {},
              });
            });
            this.json2iob.parse(id + ".general", device, { forceIndex: true });
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
        url: "https://smartapi.vesync.com/cloud/v2/deviceManaged/bypassV2",
        path: "status",
        desc: "Status of the device",
      },
    ];

    for (const element of statusArray) {
      for (const device of this.deviceArray) {
        // const url = element.url.replace("$id", id);

        await this.requestClient({
          method: "post",
          url: element.url,
          headers: {
            "content-type": "application/json",
            "user-agent": "ioBroker",
            accept: "*/*",
          },
          data: JSON.stringify({
            accountID: this.session.accountID,
            method: "bypassV2",
            deviceRegion: "EU",
            phoneOS: "iOS 14.8",
            timeZone: "Europe/Berlin",
            debugMode: false,
            cid: device.cid,
            payload: {
              method: "getHumidifierStatus",
              data: {},
              source: "APP",
            },
            configModule: "",
            traceId: Date.now(),
            phoneBrand: "iPhone 8 Plus",
            acceptLanguage: "de",
            appVersion: "VeSync 4.1.10 build2",
            userCountryCode: "DE",
            token: this.session.token,
          }),
        })
          .then(async (res) => {
            this.log.debug(JSON.stringify(res.data));
            if (!res.data) {
              return;
            }
            if (res.data.code != 0) {
              this.log.error(JSON.stringify(res.data));
              return;
            }
            let data = res.data.result;
            if (data.result) {
              data = data.result;
            }

            const forceIndex = true;
            const preferedArrayName = null;

            this.json2iob.parse(device.cid + "." + element.path, data, {
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
                this.log.info(element.path + " receive 401 error. Refresh Token in 60 seconds");
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

  async refreshToken() {
    this.log.debug("Refresh token");

    await this.login();
  }

  /**
   * Is called when adapter shuts down - callback has to be called under any circumstances!
   * @param {() => void} callback
   */
  onUnload(callback) {
    try {
      this.setState("info.connection", false, true);
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
        const deviceId = id.split(".")[2];
        const command = id.split(".")[5];

        if (id.split(".")[4] === "Refresh") {
          this.updateDevices();
          return;
        }
        const data = {
          body: {},
          header: {
            command: "setAttributes",
            said: deviceId,
          },
        };
        data.body[command] = state.val;
        await this.requestClient({
          method: "post",
          url: "",
        })
          .then((res) => {
            this.log.info(JSON.stringify(res.data));
          })
          .catch(async (error) => {
            this.log.error(error);
            error.response && this.log.error(JSON.stringify(error.response.data));
          });
        this.refreshTimeout = setTimeout(async () => {
          this.log.info("Update devices");
          await this.updateDevices();
        }, 10 * 1000);
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
