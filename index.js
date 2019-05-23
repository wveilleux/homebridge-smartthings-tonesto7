const {
    pluginName,
    platformName,
    knownCapabilities
} = require("./lib/constants");
const plugin_version = require('./package.json').version;
const myUtils = require('./lib/MyUtils');
const he_st_api = require('./lib/he_st_api');
const http = require('http');
const os = require('os');
const uuidGen = require('./accessories/he_st_accessories').uuidGen;
const uuidDecrypt = require('./accessories/he_st_accessories').uuidDecrypt;
const Logger = require('./lib/Logger.js').Logger;
var Service,
    Characteristic,
    Accessory,
    uuid,
    HE_ST_Accessory,
    User,
    PlatformAccessory;

module.exports = function(homebridge) {
    console.log("Homebridge Version: " + homebridge.version);
    console.log("Plugin Version: " + plugin_version);
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;
    Accessory = homebridge.hap.Accessory;
    User = homebridge.user;
    uuid = homebridge.hap.uuid;
    PlatformAccessory = homebridge.platformAccessory;
    HE_ST_Accessory = require('./accessories/he_st_accessories')(Accessory, Service, Characteristic, PlatformAccessory, uuid);
    homebridge.registerPlatform(pluginName, platformName, HE_ST_Platform, true);
};

function HE_ST_Platform(log, config, api) {
    this.api = api;
    this.temperature_unit = 'F';
    this.app_url = config['app_url'];
    this.app_id = config['app_id'];
    this.access_token = config['access_token'];
    this.excludedAttributes = config["excluded_attributes"] || [];
    this.excludedCapabilities = config["excluded_capabilities"] || [];
    this.polling_seconds = config['polling_seconds'] || 3600;
    this.update_method = config['update_method'] || 'direct';
    this.local_commands = false;
    this.local_hub_ip = undefined;
    this.direct_port = config['direct_port'] || (platformName === 'SmartThings' ? 8000 : 8005);
    this.myUtils = new myUtils(this);
    this.direct_ip = config['direct_ip'] || this.myUtils.getIPAddress();

    this.config = config;
    this.log = log;
    this.deviceLookup = {};
    this.firstpoll = true;
    this.unknownCapabilities = [];
    this.knownCapabilities = knownCapabilities;
    if (platformName === 'Hubitat' || platformName === 'hubitat') {
        let newList = [];
        this.knownCapabilities.forEach(cap => {
            newList.push(this.myUtil.cleanSpaces(cap));
        });
        this.knownCapabilities = newList;
    }
    this.attributeLookup = {};
    he_st_api.init(this.app_url, this.app_id, this.access_token, this.local_hub_ip, this.local_commands);
    this.api.on('didFinishLaunching', this.didFinishLaunching.bind(this));
    this.asyncCallWait = 0;
}

HE_ST_Platform.prototype = {
    addUpdateAccessory: function(deviceid, group, src, inAccessory = null, inDevice = null) {
        console.log(`src: $src | deviceid: deviceid`);
        let that = this;
        return new Promise(function(resolve, reject) {
            //that.log.error('addUpdateAccessory', deviceid, group, inAccessory, inDevice);
            var accessory;
            if (that.deviceLookup && that.deviceLookup[uuidGen(deviceid)]) {
                if (that.deviceLookup[uuidGen(deviceid)] instanceof HE_ST_Accessory) {
                    accessory = that.deviceLookup[uuidGen(deviceid)];
                    //accessory.loadData(devices[i]);
                    resolve(accessory);
                }
            } else {
                if ((inDevice === null) || (inDevice === undefined)) {
                    he_st_api.getDeviceInfo(deviceid)
                        .then(function(data) {
                            let fromCache = ((inAccessory !== undefined) && (inAccessory !== null));
                            data.excludedAttributes = (Object.keys(that.excludedAttributes).length) ? that.excludedAttributes[deviceid] : ["None"];
                            data.excludedCapabilities = (Object.keys(that.excludedCapabilities).length) ? that.excludedCapabilities[deviceid] : ["None"];
                            accessory = new HE_ST_Accessory(that, group, data, inAccessory);
                            // that.log(accessory);
                            if (accessory !== undefined) {
                                if (accessory.accessory.services.length <= 1 || accessory.deviceGroup === 'unknown') {
                                    if (that.firstpoll) {
                                        that.log.warn('Device Skipped - Name ' + accessory.name + ', ID ' + accessory.deviceid + ', JSON: ' + JSON.stringify(accessory.device));
                                    }
                                    resolve(accessory);
                                } else {
                                    that.log.good("Device Added" + (fromCache ? ' (Cache)' : '') + " - Name " + accessory.name + ", ID " + accessory.deviceid); //+", JSON: "+ JSON.stringify(device));
                                    that.deviceLookup[uuidGen(accessory.deviceid)] = accessory;
                                    if (inAccessory === null)
                                        that.api.registerPlatformAccessories(pluginName, platformName, [accessory.accessory]);
                                    accessory.loadData(data);
                                    resolve(accessory);
                                }
                            }
                        })
                        .catch(function(error) {
                            reject(error);
                        });
                } else {
                    var fromCache = ((inAccessory !== undefined) && (inAccessory !== null));
                    accessory = new HE_ST_Accessory(that, group, inDevice, inAccessory);
                    if (accessory !== undefined) {
                        if (accessory.accessory.services.length <= 1 || accessory.deviceGroup === 'unknown') {
                            if (that.firstpoll) {
                                that.log.warn('Device Skipped - Name ' + accessory.name + ', ID ' + accessory.deviceid + ', JSON: ' + JSON.stringify(inDevice));
                            }
                        } else {
                            that.log.good("Device Added" + (fromCache ? ' (Cache)' : '') + " - Name " + accessory.name + ", ID " + accessory.deviceid); //+", JSON: "+ JSON.stringify(device));
                            that.deviceLookup[uuidGen(accessory.deviceid)] = accessory;
                            if (inAccessory === null)
                                that.api.registerPlatformAccessories(pluginName, platformName, [accessory.accessory]);
                            accessory.loadData(inDevice);
                            resolve(accessory);
                        }
                    }
                }
            }
        });
    },
    removeOldDevices: function(devices) {
        var that = this;
        return new Promise(function(resolve, reject) {
            var accessories = [];
            Object.keys(that.deviceLookup).forEach(function(key) {
                if (!(that.deviceLookup[key] instanceof HE_ST_Accessory))
                    that.removeAccessory(that.deviceLookup[key]).catch(function(error) {});
            });
            Object.keys(that.deviceLookup).forEach(function(key) {
                if (that.deviceLookup[key].deviceGroup === 'reboot')
                    return;
                var unregister = true;
                for (var i = 0; i < devices.length; i++) {
                    if (that.deviceLookup[key].accessory.UUID === uuidGen(devices[i].id))
                        unregister = false;
                }
                if (unregister)
                    that.removeAccessory(that.deviceLookup[key]).catch(function(error) {});
            });
            resolve(devices);
        });
    },

    didFinishLaunching: function() {
        var that = this;
        if (that.asyncCallWait !== 0) {
            that.log("Configuration of cached accessories not done, wait for a bit...", that.asyncCallWait);
            setTimeout(that.didFinishLaunching.bind(that), 1000);
            return;
        }
        this.log('Fetching ' + platformName + ' devices. This can take a while depending on the number of devices are configured!');
        var that = this;
        var starttime = new Date();
        this.reloadData(function(foundAccessories) {
            var timeElapsedinSeconds = Math.round((new Date() - starttime) / 1000);
            if (timeElapsedinSeconds >= that.polling_seconds) {
                that.log('It took ' + timeElapsedinSeconds + ' seconds to get all data and polling_seconds is set to ' + that.polling_seconds);
                that.log(' Changing polling_seconds to ' + (timeElapsedinSeconds * 2) + ' seconds');
                that.polling_seconds = timeElapsedinSeconds * 2;
            } else if (that.polling_seconds < 30) {
                that.log('polling_seconds really shouldn\'t be smaller than 30 seconds. Setting it to 30 seconds');
                that.polling_seconds = 30;
            }
            setInterval(that.reloadData.bind(that), that.polling_seconds * 1000);
            that.log('update_method: ' + that.update_method);
            if (that.update_method === 'api') {
                // setInterval(that.doIncrementalUpdate.bind(that), that.update_seconds * 1000);
            } else if (that.update_method === 'direct') {
                // The Hub sends updates to this module using http
                he_st_api_SetupHTTPServer(that);
                he_st_api.startDirect(null, that.direct_ip, that.direct_port);
            }
        });
    },
    removeAccessory: function(accessory) {
        var that = this;
        return new Promise(function(resolve, reject) {
            if (accessory instanceof HE_ST_Accessory) {
                that.api.unregisterPlatformAccessories(pluginName, platformName, [accessory.accessory]);
                if (that.deviceLookup[accessory.accessory.UUID]) {
                    that.log.warn("Device Removed - Name " + that.deviceLookup[accessory.accessory.UUID].name + ', ID ' + that.deviceLookup[accessory.accessory.UUID].deviceid);
                    that.removeDeviceAttributeUsage(that.deviceLookup[accessory.accessory.UUID].deviceid);
                    if (that.deviceLookup.hasOwnProperty(accessory.accessory.UUID))
                        delete that.deviceLookup[accessory.accessory.UUID];
                }
            } else {
                that.log.warn("Remove stale cache device " + that.deviceLookup[accessory.UUID].displayName);
                that.api.unregisterPlatformAccessories(pluginName, platformName, [that.deviceLookup[accessory.UUID]]);
                delete that.deviceLookup[accessory.UUID];
            }
            resolve('');
        });
    },
    removeOldDevices: function(devices) {
        var that = this;
        return new Promise(function(resolve, reject) {
            var accessories = [];
            Object.keys(that.deviceLookup).forEach(function(key) {
                if (!(that.deviceLookup[key] instanceof HE_ST_Accessory))
                    that.removeAccessory(that.deviceLookup[key]).catch(function(error) {});
            });
            Object.keys(that.deviceLookup).forEach(function(key) {
                if (that.deviceLookup[key].deviceGroup === 'reboot')
                    return;
                var unregister = true;
                for (var i = 0; i < devices.length; i++) {
                    if (that.deviceLookup[key].accessory.UUID === uuidGen(devices[i].id))
                        unregister = false;
                }
                if (unregister)
                    that.removeAccessory(that.deviceLookup[key]).catch(function(error) {});
            });
            resolve(devices);
        });
    },
    populateDevices: function(devices) {
        var that = this;
        return new Promise(function(resolve, reject) {
            for (var i = 0; i < devices.length; i++) {
                var device = devices[i];
                var group = "device";
                if (device.type)
                    group = device.type;
                var deviceData = null;
                if (device.data)
                    deviceData = device.data;
                that.addUpdateAccessory(device.id, group, 'populateDevices', null, deviceData)
                    .catch(function(error) {
                        that.log.error(error);
                    });
            }
            resolve(devices);
        });
    },
    updateDevices: function() {
        var that = this;
        return new Promise(function(resolve, reject) {
            if (!that.firstpoll) {
                var updateAccessories = [];
                Object.keys(that.deviceLookup).forEach(function(key) {
                    if (that.deviceLookup[key] instanceof HE_ST_Accessory)
                        updateAccessories.push(that.deviceLookup[key].accessory);
                });
                if (updateAccessories.length)
                    that.api.updatePlatformAccessories(updateAccessories);
            }
            resolve('');
        });
    },
    reloadData: function(callback) {
        var that = this;
        // that.log('config: ', JSON.stringify(this.config));
        var foundAccessories = [];
        that.log('Loading All Device Data');
        he_st_api.getDevices()
            .then(function(myList) {
                that.log('Received All Device Data '); //, util.inspect(myList, false, null, true));
                if (myList && myList.location) {
                    that.temperature_unit = myList.location.temperature_scale;
                    if (myList.location.hubIP) {
                        that.local_hub_ip = myList.location.hubIP;
                        he_st_api.updateGlobals(that.local_hub_ip, that.local_commands);
                    }
                }
                return myList.deviceList;
            }).then(function(myList) {
                return that.removeOldDevices(myList);
            }).then(function(myList) {
                return that.populateDevices(myList);
            }).then(function(myList) {
                return that.updateDevices();
            }).then(function(myList) {
                if (callback)
                    callback(foundAccessories);
                that.firstpoll = false;
            }).catch(function(error) {
                if (error.hasOwnProperty('statusCode')) {
                    if (error.statusCode === 404) {
                        that.log.error('Hubitat tells me that the MakerAPI instance you have configured is not available (code 404).');
                    } else if (error.statusCode === 401) {
                        that.log.error('Hubitat tells me that your access code is wrong. Please check and correct it.');
                    } else if (error.statusCode === 500) {
                        that.log.error('Looks like your MakerAPI instance is disabled. Got code 500');
                    } else {
                        that.log.error('Got an unknown error code, ' + error.statusCode + ' tell dan.t in the hubitat forums and give him the following dump', error);
                    }
                } else {
                    that.log.error('Received an error trying to get the device summary information from Hubitat.', error);
                }
                that.log.error('I am stopping my reload here and hope eveything fixes themselves (e.g. a firmware update of HE is rebooting the hub');
            });
    },
    // reloadData: function(callback) {
    //     var that = this;
    //     // that.log('config: ', JSON.stringify(this.config));
    //     var foundAccessories = [];
    //     that.log.debug('Refreshing All Device Data');
    //     he_st_api.getDevices(function(myList) {
    //         that.log.debug('Received All Device Data');
    //         // success
    //         if (myList && myList.deviceList && myList.deviceList instanceof Array) {
    //             var populateDevices = function(devices) {
    //                 for (var i = 0; i < devices.length; i++) {
    //                     var device = devices[i];
    //                     device.excludedCapabilities = that.excludedCapabilities[device.deviceid] || ["None"];
    //                     var accessory;
    //                     if (that.deviceLookup[device.deviceid]) {
    //                         accessory = that.deviceLookup[device.deviceid];
    //                         accessory.loadData(devices[i]);
    //                     } else {
    //                         accessory = new HE_ST_Accessory(that, device);
    //                         // that.log(accessory);
    //                         if (accessory !== undefined) {
    //                             if (accessory.services.length <= 1 || accessory.deviceGroup === 'unknown') {
    //                                 if (that.firstpoll) {
    //                                     that.log('Device Skipped - Group ' + accessory.deviceGroup + ', Name ' + accessory.name + ', ID ' + accessory.deviceid + ', JSON: ' + JSON.stringify(device));
    //                                 }
    //                             } else {
    //                                 // that.log("Device Added - Group " + accessory.deviceGroup + ", Name " + accessory.name + ", ID " + accessory.deviceid); //+", JSON: "+ JSON.stringify(device));
    //                                 that.deviceLookup[accessory.deviceid] = accessory;
    //                                 foundAccessories.push(accessory);
    //                             }
    //                         }
    //                     }
    //                 }
    //             };
    //             if (myList && myList.location) {
    //                 that.temperature_unit = myList.location.temperature_scale;
    //                 if (myList.location.hubIP) {
    //                     that.local_hub_ip = myList.location.hubIP;
    //                     he_st_api.updateGlobals(that.local_hub_ip, that.local_commands);
    //                 }
    //             }
    //             populateDevices(myList.deviceList);
    //         } else if (!myList || !myList.error) {
    //             that.log('Invalid Response from API call');
    //         } else if (myList.error) {
    //             that.log('Error received type ' + myList.type + ' - ' + myList.message);
    //         } else {
    //             that.log('Invalid Response from API call');
    //         }
    //         if (callback) callback(foundAccessories);
    //         that.firstpoll = false;
    //     });
    // },
    // accessories: function(callback) {
    //     this.log('Fetching ' + platformName + ' devices.');

    //     var that = this;
    //     // var foundAccessories = [];
    //     this.deviceLookup = [];
    //     this.unknownCapabilities = [];
    //     this.knownCapabilities = knownCapabilities;
    //     if (platformName === 'Hubitat' || platformName === 'hubitat') {
    //         let newList = [];
    //         for (const item in this.knownCapabilities) {
    //             newList.push(this.knownCapabilities[item].replace(/ /g, ''));
    //         }
    //         this.knownCapabilities = newList;
    //     }

    //     he_st_api.init(this.app_url, this.app_id, this.access_token, this.local_hub_ip, this.local_commands);
    //     this.reloadData(function(foundAccessories) {
    //         that.log('Unknown Capabilities: ' + JSON.stringify(that.unknownCapabilities));
    //         callback(foundAccessories);
    //         that.log('update_method: ' + that.update_method);
    //         setInterval(that.reloadData.bind(that), that.polling_seconds * 1000);
    //         // Initialize Update Mechanism for realtime-ish updates.
    //         if (that.update_method === 'api') {
    //             setInterval(that.doIncrementalUpdate.bind(that), that.update_seconds * 1000);
    //         } else if (that.update_method === 'direct') {
    //             // The Hub sends updates to this module using http
    //             he_st_api_SetupHTTPServer(that);
    //             he_st_api.startDirect(null, that.direct_ip, that.direct_port);
    //         }
    //     });
    // },
    configureAccessory: function(accessory) {
        var done = false;

        if (this.disabled === true)
            return;
        var that = this;
        var deviceIdentifier = accessory.getService(Service.AccessoryInformation).getCharacteristic(Characteristic.SerialNumber).value.split(':');
        if (deviceIdentifier.length > 1) {
            that.asyncCallWait++;

            that.addUpdateAccessory(deviceIdentifier[1], deviceIdentifier[0], 'configureAccessory', accessory).then(function() {
                that.asyncCallWait--;
                done = true;
            }).catch(function(error) {
                if (error.errorCode === 2) {
                    that.log.warn('Device Skipped - Name ' + accessory.name + ', ID ' + deviceIdentifier[1] + ' - Received Code 404, mark for removal from cache');
                    that.deviceLookup[accessory.UUID] = accessory;
                } else {
                    that.log(error);
                    that.log.error('Going to exit here to not destroy your room assignments.');
                    process.exit(1);
                }
                that.asyncCallWait--;
                done = true;
            });
        } else {
            this.log.warn("Invalid Device Indentifier stored in cache, remove device" + accessory.getService(Service.AccessoryInformation).getCharacteristic(Characteristic.Name).value);
            this.deviceLookup[accessory.UUID] = accessory;
            done = true;
        }
    },
    accessories: function(callback) {
        var that = this;
        callback([]);
    },
    isAttributeUsed: function(attribute, deviceid) {
        if (!this.attributeLookup[attribute])
            return false;
        if (!this.attributeLookup[attribute][deviceid])
            return false;
        return true;
    },
    addAttributeUsage: function(attribute, deviceid, mycharacteristic) {
        if (!this.attributeLookup[attribute]) {
            this.attributeLookup[attribute] = {};
        }
        if (!this.attributeLookup[attribute][deviceid]) {
            this.attributeLookup[attribute][deviceid] = [];
        }
        this.attributeLookup[attribute][deviceid].push(mycharacteristic);
    },
    removeDeviceAttributeUsage: function(deviceid) {
        var that = this;
        Object.entries(that.attributeLookup).forEach((entry) => {
            const [key, value] = entry;
            if (that.attributeLookup[key].hasOwnProperty(deviceid))
                delete that.attributeLookup[key][deviceid];
        });
    },
    getAttributeValue: function(attribute, deviceid, that) {
        if (!(that.attributeLookup[attribute] && that.attributeLookup[attribute][deviceid])) {
            return null;
        }
        var myUsage = that.attributeLookup[attribute][deviceid];
        if (myUsage instanceof Array) {
            for (var j = 0; j < myUsage.length; j++) {
                var accessory = that.deviceLookup[uuidGen(deviceid)];
                if (accessory) {
                    return accessory.device.attributes[attribute];
                }
            }
        }
    },
    processFieldUpdate: function(attributeSet, that) {
        if (!(that.attributeLookup[attributeSet.attribute] && that.attributeLookup[attributeSet.attribute][attributeSet.device])) {
            return;
        }
        var myUsage = that.attributeLookup[attributeSet.attribute][attributeSet.device];
        if (myUsage instanceof Array) {
            for (var j = 0; j < myUsage.length; j++) {
                var accessory = that.deviceLookup[uuidGen(attributeSet.device)];
                if (accessory) {
                    accessory.device.attributes[attributeSet.attribute] = attributeSet.value;
                    myUsage[j].getValue();
                }
            }
        }
    },

    // doIncrementalUpdate: function() {
    //     var that = this;
    //     he_st_api.getUpdates(function(data) {
    //         that.processIncrementalUpdate(data, that);
    //     });
    // },

    // processIncrementalUpdate: function(data, that) {
    //     that.log('new data: ' + data);
    //     if (data && data.attributes && data.attributes instanceof Array) {
    //         for (var i = 0; i < data.attributes.length; i++) {
    //             that.processFieldUpdate(data.attributes[i], that);
    //         }
    //     }
    // }
};

function getIPAddress() {
    var interfaces = os.networkInterfaces();
    for (var devName in interfaces) {
        var iface = interfaces[devName];
        for (var i = 0; i < iface.length; i++) {
            var alias = iface[i];
            if (alias.family === 'IPv4' && alias.address !== '127.0.0.1' && !alias.internal) {
                return alias.address;
            }
        }
    }
    return '0.0.0.0';
}

function he_st_api_SetupHTTPServer(myHe_st_api) {
    // Get the IP address that we will send to the SmartApp. This can be overridden in the config file.
    let ip = myHe_st_api.direct_ip || getIPAddress();
    // Start the HTTP Server
    const server = http.createServer(function(request, response) {
        he_st_api_HandleHTTPResponse(request, response, myHe_st_api);
    });

    server.listen(myHe_st_api.direct_port, err => {
        if (err) {
            myHe_st_api.log('something bad happened', err);
            return '';
        }
        myHe_st_api.log(`Direct Connect Is Listening On ${ip}:${myHe_st_api.direct_port}`);
    });
    return 'good';
}

function he_st_api_HandleHTTPResponse(request, response, myHe_st_api) {
    if (request.url === '/restart') {
        let delay = (10 * 1000);
        myHe_st_api.log('Received request from ' + platformName + ' to restart homebridge service in (' + (delay / 1000) + ' seconds) | NOTICE: If you using PM2 or Systemd the Homebridge Service should start back up');
        setTimeout(function() {
            process.exit(1);
        }, parseInt(delay));
    }
    if (request.url === '/updateprefs') {
        myHe_st_api.log(platformName + ' Hub Sent Preference Updates');
        let body = [];
        request.on('data', (chunk) => {
            body.push(chunk);
        }).on('end', () => {
            body = Buffer.concat(body).toString();
            let data = JSON.parse(body);
            let sendUpd = false;
            if (platformName === 'SmartThings') {
                if (data.local_commands && myHe_st_api.local_commands !== data.local_commands) {
                    sendUpd = true;
                    myHe_st_api.log(platformName + ' Updated Local Commands Preference | Before: ' + myHe_st_api.local_commands + ' | Now: ' + data.local_commands);
                    myHe_st_api.local_commands = data.local_commands;
                }
                if (data.local_hub_ip && myHe_st_api.local_hub_ip !== data.local_hub_ip) {
                    sendUpd = true;
                    myHe_st_api.log(platformName + ' Updated Hub IP Preference | Before: ' + myHe_st_api.local_hub_ip + ' | Now: ' + data.local_hub_ip);
                    myHe_st_api.local_hub_ip = data.local_hub_ip;
                }
            }
            if (sendUpd) {
                he_st_api.updateGlobals(myHe_st_api.local_hub_ip, myHe_st_api.local_commands);
            }
        });
    }
    if (request.url === '/initial') {
        myHe_st_api.log(platformName + ' Hub Communication Established');
    }
    if (request.url === '/update') {
        let body = [];
        request.on('data', (chunk) => {
            body.push(chunk);
        }).on('end', () => {
            body = Buffer.concat(body).toString();
            let data = JSON.parse(body);
            if (Object.keys(data).length > 3) {
                var newChange = {
                    device: data.change_device,
                    attribute: data.change_attribute,
                    value: data.change_value,
                    date: data.change_date
                };
                myHe_st_api.log('Change Event:', '(' + data.change_name + ') [' + (data.change_attribute ? data.change_attribute.toUpperCase() : 'unknown') + '] is ' + data.change_value);
                myHe_st_api.processFieldUpdate(newChange, myHe_st_api);
            }
        });
    }
    response.end('OK');
}