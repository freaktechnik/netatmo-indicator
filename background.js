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
            browser.alarms.create(this.UPDATE_ALARM, {
                periodInMinutes: 10
            });
            this.hasUpdateLoop = true;
            await this.getStationData();
        }
    },
    async getStationData() {
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
            if(devices.length) {
                const station = devices[0];
                return this.setState(`${station.station_name} - ${station.module_name}`, station.dashboard_data.CO2);
            }
        }
        throw new Error("Failed to fetch station data");
    },
    async getHomeCoachData() {
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
            if(devices.length) {
                const station = device[0];
                return this.setState(station.name || station.module_name, station.dashboard_data.CO2);
            }
        }
        throw new Error("failed to fetch health coach data");
    },
    async restoreState() {
        const { name, co2 } = await browser.storage.local.get([ 'name', 'co2' ]);
        if(name) {
            this.name = name;
            this.co2 = co2;
            await this.updateButton();
        }
    },
    async setState(name, co2) {
        this.name = name;
        this.co2 = co2;
        await browser.storage.local.set({
            name,
            co2
        });
        await this.updateButton();
    },
    getImage() {
        if(this.co2 >= 1500) {
            return browser.runtime.getURL('status/red.svg');
        }
        else if(this.co2 >= 1000) {
            return browser.runtime.getURL('status/orange.svg');
        }
        else if(this.co2 >= 800) {
            return browser.runtime.getURL('status/yellow.svg');
        }
        else if(this.co2 >= 0) {
            return browser.runtime.getURL('status/green.svg');
        }
        return browser.runtime.getURL('status/gray.svg');
    },
    getColor() {
        if(this.co2 >= 1500) {
            return '#ff0039';
        }
        else if(this.co2 >= 1000) {
            return '#ff9400';
        }
        else if(this.co2 >= 800) {
            return '#ffe900';
        }
        else if(this.co2 >= 0) {
            return '#30e60b';
        }
    },
    getDarkColor() {
        if(this.co2 >= 1500) {
            return '#5a0002';
        }
        else if(this.co2 >= 1000) {
            return '#712b00';
        }
        else if(this.co2 >= 800) {
            return '#715100';
        }
        else if(this.co2 >= 0) {
            return '#006504';
        }
    },
    async updateButton() {
        await browser.browserAction.setIcon({
            path: this.getImage()
        });
        await browser.browserAction.setTitle({
          title: `${this.name}: ${this.co2}ppm`
        });
        const { updateTheme, ppmOnBadge } = await browser.storage.local.get({
            updateTheme: false,
            ppmOnBadge: false
        });
        if(ppmOnBadge) {
            await Promise.all([
                browser.browserAction.setBadgeText({
                    text: this.co2.toString(10)
                }),
                browser.browserAction.setBadgeBackgroundColor({
                    color: this.getDarkColor()
                })
            ]);
        }
        else {
            await browser.browserAction.setBadgeText({
                text: ''
            });
        }
        if(updateTheme) {
            const color = this.getColor();
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
    async init() {
        browser.alarms.onAlarm.addListener((alarm) => {
            if(alarm.name === this.REFRESH_ALARM) {
                this.refreshToken().catch(console.error);
            }
            else if(alarm.name == this.UPDATE_ALARM) {
                //TODO also support health thingie.
                this.getStationData().catch(console.error);
            }
        });
        browser.browserAction.onClicked.addListener(() => {
            browser.tabs.create({
                url: 'https://my.netatmo.com'
            });
        });
        browser.storage.onChanged.addListener((changes, area) => {
            if(area === 'local') {
                if(('ppmOnBadge' in changes) || ('updateTheme' in changes && changes.updateTheme.newValue)) {
                    this.updateButton();
                }
                if('updateTheme' in changes && changes.updateTheme.oldValue && !changes.updateTheme.newValue) {
                    browser.theme.reset();
                }
            }
        });
        const { token, expires, refreshToken } = await browser.storage.local.get([
            'token',
            'expires',
            'refreshToken'
        ]);
        if(!token) {
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
                    this.storeToken(data.access_token, data.expires_in * 1000, data.refresh_token);
                }
            }
            else {
                throw new Error("Auth failed");
            }
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
