"use strict";

const API_BASE = 'https://api.netatmo.com/';
const redirectUri = 'https://netatmo.humanoids.be';
const HEX = 16;
const DEFAULT_BOUNDARIES = {
    yellow: 800,
    orange: 1000,
    red: 1500
};

const getOutdoorModule = (device) => {
    if(device.hasOwnProperty('modules')) {
        return device.modules.find((m) => m.type === "NAModule1");
    }
    return undefined;
};
const normalizeModule = (module, station) => {
    const normalized = Object.assign({}, module);
    normalized.station_name = station.station_name;
    normalized.module_id = module._id;
    normalized._id = station._id;
    return normalized;
};
const findDevice = (stations, device) => {
    for(const d of stations) {
        if(d._id === device.id) {
            if(device.hasOwnProperty('module_id') && d.hasOwnProperty('modules')) {
                for(const module of d.modules) {
                    if(module._id === device.module_id) {
                        return normalizeModule(module, d);
                    }
                }
            }
            return d;
        }
    }
    return {};
};
const formatDevice = (device, type, canDelta = false) => {
    const formatted = {
        type,
        id: device._id,
        co2: device.dashboard_data.CO2,
        temp: device.dashboard_data.Temperature,
        canDelta
    };
    if(device.hasOwnProperty('module_id')) {
        formatted.module_id = device.module_id;
    }
    if(type == 'coach') {
        formatted.group = 'Health coach';
        const name = device.name || device.module_name;
        formatted.module = name;
        formatted.name = name;
    }
    else if(type == 'weather') {
        formatted.group = device.station_name;
        formatted.module = device.module_name;
        formatted.name = `${device.station_name} - ${device.module_name}`;
    }
    return formatted;
};
//TODO window open detection based on noise levels

const BUTTON_PREFS = [
    'ppmOnBadge',
    // 'updateTheme', a bit more complicated for resetting
    'onlyWarnTheme',
    'windowBadge',
    'boundaries'
];

const netatmo = {
    REFRESH_ALARM: 'refresh',
    UPDATE_ALARM: 'update',
    hasUpdateLoop: false,
    canDelta: false,
    async refreshToken() {
        const { refreshToken } = await browser.storage.local.get('refreshToken');
        const body = new URLSearchParams();
        body.append('grant_type', 'refresh_token');
        body.append('refresh_token', refreshToken);
        body.append('client_id', clientToken);
        body.append('client_secret', clientSecret);
        const res = await fetch(`${API_BASE}oauth2/token`, {
            method: 'POST',
            body
        });
        if(res.ok) {
            const data = await res.json();
            this.storeToken(data.access_token, data.expires_in * 1000, data.refresh_token);
        }
    },
    async storeToken(token, expiresIn, refreshToken) {
        const date = Date.now() + expiresIn;
        await browser.storage.local.set({
            token,
            refreshToken,
            expires: date
        });
        this.token = token;
        this.scheduleRefresh(date);
        await this.ensureUpdateLoop();
    },
    scheduleRefresh(date) {
        browser.alarms.create(this.REFRESH_ALARM, {
            when: date
        });
    },
    async ensureUpdateLoop() {
        if(!this.hasUpdateLoop) {
            const stations = await this.getStationsList();
            if(stations.length || this.device) {
                const { interval } = await browser.storage.local.get({
                    interval: 10
                });
                if(!this.device) {
                    await this.restoreState(stations);
                }
                const alarmSpec = {
                    periodInMinutes: interval,
                };
                if(this.device) {
                    alarmSpec.when = Date.now();
                }
                browser.alarms.create(this.UPDATE_ALARM, alarmSpec);
                this.hasUpdateLoop = true;
            }
        }
    },
    async getStationsData() {
        if(!this.token) {
            throw new Error("Not authorized");
        }
        const body = new URLSearchParams();
        body.append('access_token', this.token);
        const res = await fetch(`${API_BASE}api/getstationsdata`, {
            method: 'POST',
            body
        });
        if(res.ok) {
            const data = await res.json();
            const { body: { devices } } = data;
            const allDevices = [];
            if(Array.isArray(devices)) {
                for(const d of devices) {
                    this.canDelta = false;
                    if(d.modules.length) {
                        const outdoorModule = getOutdoorModule(d);
                        if(outdoorModule) {
                            this.outdoorTemperature = outdoorModule.dashboard_data.Temperature;
                            this.canDelta = true;
                        }
                        for(const module of d.modules) {
                            if(module.dashboard_data.hasOwnProperty('CO2')) {
                                allDevices.push(formatDevice(normalizeModule(module, d), 'weather', this.canDelta));
                            }
                        }
                    }
                    allDevices.push(formatDevice(d, 'weather', this.canDelta));
                }
            }
            return allDevices;
        }
        throw new Error("Failed to fetch station data");
    },
    async getStationData() {
        if(!this.token) {
            throw new Error("Not authorized");
        }
        const body = new URLSearchParams();
        body.append('access_token', this.token);
        body.append('device_id', this.device.id);
        const res = await fetch(`${API_BASE}api/getstationsdata`, {
            method: 'POST',
            body
        });
        if(res.ok) {
            const data = await res.json();
            const { body: { devices } } = data;
            if(Array.isArray(devices)) {
                const device = findDevice(devices, this.device);
                const outdoorModule = getOutdoorModule(findDevice(devices, {
                    id: device.id
                }));
                const newDevice = Object.assign({}, this.device);
                if(outdoorModule) {
                    newDevice.temp = device.dashboard_data.Temperature;
                }
                newDevice.co2 = device.dashboard_data.CO2;
                newDevice.group = device.station_name;
                newDevice.module = device.module_name;
                newDevice.name = `${device.station_name} - ${device.module_name}`;
                return this.setState(newDevice, true, outdoorModule);
            }
        }
        throw new Error("Failed to update station data");
    },
    async getHomeCoachesData() {
        if(!this.token) {
            throw new Error("Not authorized");
        }
        const body = new URLSearchParams();
        body.append('access_token', this.token);
        const res = await fetch(`${API_BASE}api/gethomecoachsdata`, {
            method: 'POST',
            body
        });
        if(res.ok) {
            const data = await res.json();
            const { body: devices } = data;
            if(Array.isArray(devices)) {
                return devices.map((d) => formatDevice(d, 'coach'));
            }
            return [];
        }
        throw new Error("failed to fetch health coach data");
    },
    async getHomeCoachData() {
        if(!this.token) {
            throw new Error("Not authorized");
        }
        const body = new URLSearchParams();
        body.append('access_token', this.token);
        body.append('device_id', this.device.id);
        const res = await fetch(`${API_BASE}api/gethomecoachsdata`, {
            method: 'POST',
            body
        });
        if(res.ok) {
            const data = await res.json();
            const { body: devices } = data;
            if(Array.isArray(devices)) {
                const d = findDevice(devices, this.device);
                const newDevice = Object.assign({}, this.device);
                newDevice.temp = d.dashboard_data.Temperature;
                newDevice.co2 = d.dashboard_data.CO2;
                newDevice.module = d.name || d.module_name;
                newDevice.name = newDevice.module;
                return this.setState(newDevice);
            }
        }
        throw new Error("failed to update health coach data");
    },
    updateData() {
        console.log("updating", this.device);
        if(this.device.type === 'weather') {
            return this.getStationData();
        }
        else if(this.device.type === 'coach') {
            return this.getHomeCoachData();
        }
    },
    async restoreState(stations) {
        const { device } = await browser.storage.local.get('device');
        if(device) {
            let updatedDevice = stations.find((d) => d.id === device.id);
            if(!updatedDevice) {
                updatedDevice = device;
            }
            await this.setState(device, false);
        }
        else if(stations && stations.length) {
            await this.setState(stations[0], false);
        }
    },
    async setState(device, store = true, outdoorModule) {
        console.log(device);
        const prevCO2 = this.device ? this.device.co2 : -1;
        this.device = device;
        if(outdoorModule) {
            this.outdoorTemperature = outdoorModule.dashboard_data.Temperature;
        }
        else if(store) {
            this.outdoorTemperature = undefined;
        }
        if(store) {
            await browser.storage.local.set({
                device
            });
        }
        await Promise.all([
            this.updateButton(),
            this.showNotification(prevCO2)
        ]);
    },
    getImage(boundaries) {
        if(this.device.co2 >= boundaries.red) {
            return 'status/red.svg';
        }
        else if(this.device.co2 >= boundaries.orange) {
            return 'status/orange.svg';
        }
        else if(this.device.co2 >= boundaries.yellow) {
            return 'status/yellow.svg';
        }
        else if(this.device.co2 >= 0) {
            return 'status/green.svg';
        }
        return 'status/gray.svg';
    },
    getColor(boundaries, onlyWarnTheme = false) {
        if(this.device.co2 >= boundaries.red) {
            return '#ff0039';
        }
        else if(this.device.co2 >= boundaries.orange) {
            return '#ff9400';
        }
        else if(this.device.co2 >= boundaries.yellow) {
            return '#ffe900';
        }
        else if(this.device.co2 >= 0 && !onlyWarnTheme) {
            return '#30e60b';
        }
    },
    getDarkColor(boundaries) {
        if(this.device.co2 >= boundaries.red) {
            return '#5a0002';
        }
        else if(this.device.co2 >= boundaries.orange) {
            return '#712b00';
        }
        else if(this.device.co2 >= boundaries.yellow) {
            return '#715100';
        }
        else if(this.device.co2 >= 0) {
            return '#006504';
        }
    },
    async updateButton() {
        const {
            updateTheme,
            ppmOnBadge,
            onlyWarnTheme,
            boundaries,
            windowMin,
            windowDelta,
            windowBadge
        } = await browser.storage.local.get({
            updateTheme: false,
            ppmOnBadge: false,
            onlyWarnTheme: false,
            boundaries: DEFAULT_BOUNDARIES,
            windowMin: 24,
            windowDelta: 1,
            windowBadge: false
        });
        await browser.browserAction.setIcon({
            path: this.getImage(boundaries)
        });
        await browser.browserAction.setTitle({
          title: this.device ? `${this.device.name}: ${this.device.co2}ppm` : 'Netatmo CO₂ Measurement'
        });
        let badgeText = '';
        if(ppmOnBadge && this.device.co2 >= 0) {
            badgeText += this.device.co2.toString(10);
        }
        if(windowBadge && this.device.canDelta && this.device.co2 >= boundaries.yellow && this.device.temp >= windowMin && this.device.temp - this.outdoorTemperature >= windowDelta) {
            if(badgeText.length < 4) {
                badgeText += '!';
            }
            else {
                badgeText = '!';
            }
        }
        if(badgeText.length) {
            await Promise.all([
                browser.browserAction.setBadgeText({
                    text: badgeText
                }),
                browser.browserAction.setBadgeBackgroundColor({
                    color: this.getDarkColor(boundaries)
                })
            ]);
        }
        else {
            await browser.browserAction.setBadgeText({
                text: badgeText
            });
        }
        if(updateTheme) {
            const color = this.getColor(boundaries, onlyWarnTheme);
            if(color) {
                browser.theme.update({
                    colors: {
                        accentcolor: color
                    }
                });
            }
            else {
                browser.theme.reset();
            }
        }
    },
    async showNotification(prevCO2) {
        const canShow = await browser.permissions.contains({
            permissions: [
                'notifications'
            ]
        });
        if(canShow) {
            const message = `CO₂ now at ${this.device.co2}ppm`;
            const prefs = await browser.storage.local.get({
                redNotification: false,
                orangeNotification: false,
                yellowNotification: false,
                greenNotification: false,
                boundaries: DEFAULT_BOUNDARIES,
                windowDelta: 1,
                windowMin: 24
            });
            const iconUrl = this.getImage(prefs.boundaries);
            const notifSpec = {
                message,
                iconUrl,
                type: 'basic'
            };
            let shouldLowerCO2 = false;
            if(prevCO2 < prefs.boundaries.yellow && this.device.co2 >= prefs.boundaries.yellow && prefs.yellowNotification) {
                notifSpec.title = `CO₂ level above ${prefs.boundaries.yellow}ppm`;
                shouldLowerCO2 = true;
            }
            else if(prevCO2 < prefs.boundaries.orange && this.device.co2 >= prefs.boundaries.orange && prefs.orangeNotification) {
                notifSpec.title = `CO₂ level above ${prefs.boundaries.orange}ppm`;
                shouldLowerCO2 = true;
            }
            else if(prevCO2 < prefs.boundaries.red && this.device.co2 >= prefs.boundaries.red && prefs.redNotification) {
                notifSpec.title = `CO₂ level above ${prefs.boundaries.red}ppm`;
                shouldLowerCO2 = true;
            }
            else if(prevCO2 >= prefs.boundaries.yellow && this.device.co2 < prefs.boundaries.yellow && prefs.greenNotification) {
                notifSpec.title = `CO₂ back to below ${prefs.boundaries.yellow}ppm`;
            }
            if(shouldLowerCO2 && this.device.canDelta && this.device.temp >= prefs.windowMin && this.device.temp - this.outdoorTemperature >= prefs.windowDelta) {
                notifSpec.message += ". Open a window, it's cooler outside!";
            }
            if(notifSpec.title) {
                await browser.notifications.create(notifSpec);
            }
        }
    },
    async login() {
        const authState = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER).toString(HEX);
        const scopes = 'read_station+read_homecoach';
        const url = await browser.identity.launchWebAuthFlow({
            url: `${API_BASE}oauth2/authorize?client_id=${clientToken}&client_secret=${clientSecret}&redirect_uri=${redirectUri}&state=${authState}&scope=${scopes}`,
            interactive: true
        });
        const parsedUrl = new URL(url);
        if(parsedUrl.searchParams.has('state') && parsedUrl.searchParams.get('state') === authState && parsedUrl.searchParams.has('code')) {
            const code = parsedUrl.searchParams.get('code');
            const body = new URLSearchParams;
            body.append('scope', scopes.replace(/\+/g, ' '));
            body.append('code', code);
            body.append('grant_type', 'authorization_code');
            body.append('client_id', clientToken);
            body.append('client_secret', clientSecret);
            body.append('redirect_uri', redirectUri);
            const res = await fetch(`${API_BASE}oauth2/token`, {
                method: 'POST',
                body
            });
            if(res.ok) {
                const data = await res.json();
                await this.storeToken(data.access_token, data.expires_in * 1000, data.refresh_token);
            }
        }
        else {
            throw new Error("Auth failed");
        }
    },
    reset() {
        const p = browser.alarms.clearAll();
        this.hasUpdateLoop = false;
        this.token = undefined;
        this.outdoorTemperature = undefined;
        const p2 = this.setState(undefined);
        return Promise.all([ p, p2 ]);
    },
    async getStationsList() {
        const [ weather, healthcoach ] = await Promise.all([
            this.getStationsData(),
            this.getHomeCoachesData()
        ]);
        const allDevices = weather.concat(healthcoach);
        return allDevices;
    },
    async init() {
        browser.alarms.onAlarm.addListener((alarm) => {
            if(alarm.name === this.REFRESH_ALARM) {
                this.refreshToken().catch(console.error);
            }
            else if(alarm.name == this.UPDATE_ALARM) {
                this.updateData().catch(console.error);
            }
        });
        browser.browserAction.onClicked.addListener(() => {
            browser.tabs.create({
                url: 'https://my.netatmo.com'
            });
        });
        browser.storage.onChanged.addListener((changes, area) => {
            if(area === 'local') {
                if(BUTTON_PREFS.some((p) => changes.hasOwnProperty(p)) || (changes.hasOwnProperty('updateTheme') && changes.updateTheme.newValue)) {
                    this.updateButton().catch(console.error);
                }
                if(changes.hasOwnProperty('updateTheme') && changes.updateTheme.oldValue && !changes.updateTheme.newValue) {
                    browser.theme.reset();
                }
                if(changes.hasOwnProperty('token') && !changes.token.newValue) {
                    this.reset().catch(console.error);
                }
                if(changes.hasOwnProperty('device') && (changes.device.newValue.id != changes.device.oldValue.id || changes.device.newValue.module_id != changes.device.oldValue.module_id)) {
                    this.setState(changes.device.newValue, false);
                    this.ensureUpdateLoop();
                }
                if(changes.hasOwnProperty('interval') && this.hasUpdateLoop) {
                    browser.alarms.clear(this.UPDATE_ALARM).then(() => {
                        browser.alarms.create(this.UPDATE_ALARM, {
                            periodInMinutes: changes.interval.newValue
                        });
                    }).catch(console.error);
                }
            }
        });
        browser.runtime.onMessage.addListener((message) => {
            if(message === 'login') {
                return this.login();
            }
            else if(message === 'getstations') {
                return this.getStationsList();
            }
        });
        browser.permissions.contains({
            permissions: [
                'notifications'
            ]
        }).then((hasNotifs) => {
            const addListener = () => browser.notifications.onShown.addListener(() => {
                browser.runtime.sendMessage("@notification-sound", "new-notification");
            });
            if(hasNotifs) {
                addListener();
            }
            else {
                const listener = (change) => {
                    if(change.permissions && change.permissions.includes('notifications'))
                    {
                        addListener();
                        browser.permissions.onAdded.removeListener(listener);
                    }
                };
                browser.permissions.onAdded.addListener(listener);
            }
        });
        const { token, expires } = await browser.storage.local.get([
            'token',
            'expires'
        ]);
        if(!token) {
            await this.login();
        }
        else {
            this.token = token;
            if(expires > Date.now()) {
                this.scheduleRefresh(expires);
                await this.ensureUpdateLoop();
            }
            else {
                await this.refreshToken();
            }
        }
    }
};
netatmo.init().catch(console.error);
