"use strict";

const API_BASE = 'https://api.netatmo.com/';
const redirectUri = 'https://netatmo.humanoids.be';
const HEX = 16;

//TODO get actual API credentials (netatmo had a disruption when I first wrote this)
//TODO let user choose station, including health thingies.
//TODO let user choose barriers between the different states
//TODO let user actually enable dynamic theme part

const netatmo = {
    REFRESH_ALARM: 'refresh',
    UPDATE_ALARM: 'update',
    hasUpdateLoop: false,
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
                const { interval } = browser.storage.local.get({
                    interval: 10
                });
                browser.alarms.create(this.UPDATE_ALARM, {
                    periodInMinutes: interval
                });
                this.hasUpdateLoop = true;

                if(!this.device) {
                    this.setState(stations[0]);
                }
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
                    allDevices.push({
                        type: 'weather',
                        group: d.station_name,
                        module: d.module_name,
                        name: `${d.station_name} - ${d.module_name}`,
                        id: d._id,
                        co2: d.dashboard_data.CO2
                    });
                    if(d.modules.length) {
                        for(const module of d.modules) {
                            if(module.dashboard_data.hasOwnProperty('CO2')) {
                                allDevices.push({
                                    type: 'weather',
                                    group: d.station_name,
                                    module: module.module_name,
                                    name: `${d.station_name} - ${module.module_name}`,
                                    id: d._id,
                                    module_id: module._id,
                                    co2: d.dashboard_data.CO2
                                });
                            }
                        }
                    }
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
                for(const d of devices) {
                    if(d._id === this.device.id) {
                        let device = d;
                        if(this.device.hasOwnProperty('module_id')) {
                            for(const module of d.modules) {
                                if(module._id === this.device.module_id) {
                                    device = module;
                                    break;
                                }
                            }
                        }
                        this.device.co2 = device.dashboard_data.CO2;
                        this.device.group = d.station_name;
                        this.device.module = device.module_name;
                        this.device.name = `${d.station_name} - ${device.module_name}`;
                        return this.setState(this.device);
                    }
                }
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
                return devices.map((d) => {
                    const name = d.name || d.module_name;
                    return {
                        type: 'coach',
                        group: 'Health coach',
                        module: name,
                        name,
                        id: d._id,
                        co2: d.dashboard_data.CO2
                    };
                });
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
            for(const d of devices) {
                if(d._id === this.device.id) {
                    this.device.co2 = d.dashboard_data.CO2;
                    this.device.module = d.name || d.module_name;
                    this.device.name = this.device.module;
                    return this.setState(this.device);
                }
            }
        }
        throw new Error("failed to update health coach data");
    },
    updateData() {
        if(this.device.type === 'weather') {
            return this.getStationData();
        }
        else if(this.device.type === 'coach') {
            return this.getHomeCoachData();
        }
    },
    async restoreState() {
        const { device } = await browser.storage.local.get([ 'device' ]);
        if(device) {
            this.device = device;
            await this.updateButton();
        }
    },
    async setState(device, store = true) {
        this.device = device;
        if(store) {
            await browser.storage.local.set({
                device
            });
        }
        await this.updateButton();
    },
    getImage(boundaries) {
        if(this.device.co2 >= boundaries.red) {
            return browser.runtime.getURL('status/red.svg');
        }
        else if(this.device.co2 >= boundaries.orange) {
            return browser.runtime.getURL('status/orange.svg');
        }
        else if(this.device.co2 >= boundaries.yellow) {
            return browser.runtime.getURL('status/yellow.svg');
        }
        else if(this.device.co2 >= 0) {
            return browser.runtime.getURL('status/green.svg');
        }
        return browser.runtime.getURL('status/gray.svg');
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
        const { updateTheme, ppmOnBadge, onlyWarnTheme, boundaries } = await browser.storage.local.get({
            updateTheme: false,
            ppmOnBadge: false,
            onlyWarnTheme: false,
            boundaries: {
                yellow: 800,
                orange: 1000,
                red: 1500
            }
        });
        await browser.browserAction.setIcon({
            path: this.getImage(boundaries)
        });
        await browser.browserAction.setTitle({
          title: this.device ? `${this.device.name}: ${this.device.co2}ppm` : 'Netatmo CO₂ Measurement'
        });
        if(ppmOnBadge && this.device.co2 >= 0) {
            await Promise.all([
                browser.browserAction.setBadgeText({
                    text: this.device.co2.toString(10)
                }),
                browser.browserAction.setBadgeBackgroundColor({
                    color: this.getDarkColor(boundaries)
                })
            ]);
        }
        else {
            await browser.browserAction.setBadgeText({
                text: ''
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
                if(changes.hasOwnProperty('ppmOnBadge') || (changes.hasOwnProperty('updateTheme') && changes.updateTheme.newValue) || changes.hasOwnProperty('onlyWarnTheme') || changes.hasOwnProperty('boundaries')) {
                    this.updateButton().catch(console.error);
                }
                if(changes.hasOwnProperty('updateTheme') && changes.updateTheme.oldValue && !changes.updateTheme.newValue) {
                    browser.theme.reset();
                }
                if(changes.hasOwnProperty('token') && !changes.token.newValue) {
                    this.reset().catch(console.error);
                }
                if(changes.hasOwnProperty('device')) {
                    this.setState(changes.device.newValue, false);
                    this.ensureUpdateLoop();
                }
                if(changes.hasOwnProperty('interval')) {
                    if(this.hasUpdateLoop) {
                        browser.alarms.clear(this.UPDATE_ALARM).then(() => {
                            browser.alarms.create(this.UPDATE_ALARM, {
                                periodInMinutes: changes.interval.newValue
                            });
                        }).catch(console.error);
                    }
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
