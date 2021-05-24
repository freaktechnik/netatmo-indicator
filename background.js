"use strict";
/* This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/.
 */
/* globals clientToken, clientSecret */
//TODO add alternative weather API to use instead of an outdoor module.

const HEX = 16,
    TEN = 10,
    MINUTE = 60,
    S_TO_MS = 1000,
    FIRST = 0,
    UNSET = -1,
    FOUR_DIGITS = 1000,
    NOT_AUTHORIZED = 403,
    OFFLINE = 0,
    MAX_NETWORK_ERRORS = 10,
    BACKOFF_BASE_MINS = 2,
    /* eslint-disable camelcase */
    normalizeModule = (module, station) => {
        const normalized = Object.assign({}, module);
        normalized.station_name = station.station_name;
        normalized.module_id = module._id;
        normalized._id = station._id;
        return normalized;
    },
    isSameDevice = (a, b) => a && b && a.id === b.id && a.module_id === b.module_id,
    getOutdoorModules = (device) => {
        if(device.hasOwnProperty('modules')) {
            return device.modules.filter((m) => m.type === "NAModule1").map((m) => normalizeModule(m, device));
        }
        return [];
    },
    formatDevice = (device, type) => {
        const formatted = {
            type,
            id: device._id
        };
        if(device.dashboard_data) {
            formatted.temp = device.dashboard_data.Temperature;
            if(device.dashboard_data.hasOwnProperty('CO2') && type !== 'outdoor') {
                formatted.co2 = device.dashboard_data.CO2;
            }
        }
        else {
            formatted.temp = NaN;
        }
        if(device.hasOwnProperty('module_id')) {
            formatted.module_id = device.module_id;
        }
        if(type === 'coach') {
            formatted.group = 'Health coach';
            const name = device.name || device.module_name;
            formatted.module = name;
            formatted.name = name;
        }
        else if(type === 'weather' || type === 'outdoor') {
            formatted.group = device.station_name;
            formatted.module = device.module_name;
            formatted.name = `${device.station_name} - ${device.module_name}`;
        }
        return formatted;
    },
    stripDevice = (device) => ({
        type: device?.type,
        id: device?.id,
        module_id: device?.module_id,
        group: device?.group,
        name: device?.name,
        module: device?.module,
        co2: UNSET,
        temp: NaN
    }),
    findOutdoorModules = (stations) => {
        const modules = stations.map((s) => getOutdoorModules(s)).flat();
        return modules.map((m) => formatDevice(m, 'outdoor'));
    },
    findDevice = (stations, device) => {
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
    },
    waitForOnline = () => new Promise((resolve) => {
        window.addEventListener("online", resolve, {
            once: true,
            passive: true
        });
    }),
    /* eslint-enable camelcase */
    netatmo = {
        BUTTON_PREFS: [
            'ppmOnBadge',
            // 'updateTheme', a bit more complicated for resetting
            'onlyWarnTheme',
            'windowBadge',
            'boundaries',
            'alwaysWindowBadge'
        ],
        DEFAULT_BOUNDARIES: {
            yellow: 800,
            orange: 1000,
            red: 1500
        },
        DEFAULT_WINDOW_MIN: 1,
        DEFAULT_WINDOW_DELTA: 24,
        REFRESH_ALARM: 'refresh',
        UPDATE_ALARM: 'update',
        API_BASE: 'https://api.netatmo.com/',
        SAFETY_OFFSET: 100,
        hasUpdateLoop: false,
        redirectUri: browser.identity.getRedirectURL(),
        waitingForOnline: false,
        networkErrorTries: 0,
        async refreshToken() {
            if(!navigator.onLine) {
                if(this.waitingForOnline) {
                    return;
                }
                this.waitingForOnline = true;
                await waitForOnline();
            }
            try {
                const { refreshToken } = await browser.storage.local.get('refreshToken'),
                    body = new URLSearchParams();
                body.append('grant_type', 'refresh_token');
                body.append('refresh_token', refreshToken);
                body.append('client_id', clientToken);
                body.append('client_secret', clientSecret);
                const response = await fetch(`${this.API_BASE}oauth2/token`, {
                    method: 'POST',
                    body
                });
                this.networkErrorTries = 0;
                if(response.ok) {
                    const data = await response.json();
                    this.waitingForOnline = false;
                    return this.storeToken(data.access_token, data.expires_in * S_TO_MS, data.refresh_token);
                }
                if(response.status === OFFLINE) {
                    if(!this.waitingForOnline) {
                        this.waitingForOnline = true;
                        await waitForOnline();
                        return this.refreshToken();
                    }
                    return;
                }
                this.waitingForOnline = false;
                throw new Error("Could not fetch new token");
            }
            catch(error) {
                if (error instanceof TypeError && error.name === "NetworkError" && this.networkErrorTries < MAX_NETWORK_ERRORS) {
                    const waitFor = (BACKOFF_BASE_MINS ** this.networkErrorTries) * MINUTE * S_TO_MS;
                    ++this.networkErrorTries;
                    await new Promise((resolve) => setTimeout(resolve, waitFor));
                    return this.refreshToken();
                }
                console.error(error);
                this.reset();
            }
        },
        async storeToken(token, expiresIn, refreshToken) {
            const secondTimestampInMS = Math.floor(Date.now() / S_TO_MS) * S_TO_MS,
                date = secondTimestampInMS + expiresIn;
            await browser.storage.local.set({
                token,
                refreshToken,
                expires: date
            });
            this.token = token;
            this.scheduleRefresh(date);
            await this.ensureUpdateLoop();
        },
        scheduleRefresh(when) {
            browser.alarms.create(this.REFRESH_ALARM, {
                when
            });
        },
        async ensureUpdateLoop() {
            if(!this.hasUpdateLoop) {
                const stations = await this.getStationsList();
                if(stations.stations.length || this.device) {
                    const { interval } = await browser.storage.local.get({
                        interval: 10
                    });
                    if(!this.device) {
                        await this.restoreState(stations);
                    }
                    const alarmSpec = {
                        periodInMinutes: interval
                    };
                    if(this.device) {
                        alarmSpec.when = Date.now() + this.SAFETY_OFFSET;
                    }
                    browser.alarms.create(this.UPDATE_ALARM, alarmSpec);
                    this.hasUpdateLoop = true;
                }
            }
        },
        async fetchStationData(id) {
            if(!this.token) {
                throw new Error("Not authorized");
            }
            const body = new URLSearchParams();
            body.append('access_token', this.token);
            if(id) {
                body.append('device_id', id);
            }
            const response = await fetch(`${this.API_BASE}api/getstationsdata`, {
                method: 'POST',
                body
            });
            if(response.ok) {
                const data = await response.json(),
                    { body: { devices } } = data;
                if(Array.isArray(devices)) {
                    return devices;
                }
                return [];
            }
            if(response.status === NOT_AUTHORIZED) {
                await this.refreshToken();
                return this.fetchStationData(id);
            }
            throw new Error("Failed to update station data");
        },
        async getStationsData() {
            const devices = await this.fetchStationData(),
                allDevices = [];
            for(const d of devices) {
                if(d.modules.length) {
                    for(const module of d.modules) {
                        if(module.dashboard_data && module.dashboard_data.hasOwnProperty('CO2')) {
                            allDevices.push(formatDevice(normalizeModule(module, d), 'weather'));
                        }
                    }
                }
                allDevices.push(formatDevice(d, 'weather'));
            }
            const outdoorModules = findOutdoorModules(devices);
            return {
                stations: allDevices,
                outdoorModules
            };
        },
        async getStationData() {
            const devices = await this.fetchStationData(this.device.id),
                device = findDevice(devices, this.device),
                newDevice = formatDevice(device, 'weather');
            let outdoorModule;
            if(this.outdoorModule) {
                let outdoorModuleParent = device;
                if(newDevice.id !== this.outdoorModule.id) {
                    outdoorModuleParent = await this.fetchStationData(this.outdoorModule.id);
                }
                else if(device.hasOwnProperty('module_id')) {
                    outdoorModuleParent = findDevice(devices, {
                        id: this.outdoorModule.id
                    });
                }
                const rawOutdoorModule = findDevice([ outdoorModuleParent ], this.outdoorModule);
                outdoorModule = formatDevice(rawOutdoorModule, 'outdoor');
            }
            return this.setState(newDevice, true, outdoorModule);
        },
        async getHomeCoachesData() {
            if(!this.token) {
                throw new Error("Not authorized");
            }
            const body = new URLSearchParams();
            body.append('access_token', this.token);
            const response = await fetch(`${this.API_BASE}api/gethomecoachsdata`, {
                method: 'POST',
                body
            });
            if(response.ok) {
                const data = await response.json(),
                    { body: devices } = data;
                if(Array.isArray(devices)) {
                    return devices.map((d) => formatDevice(d, 'coach'));
                }
                return [];
            }
            if(response.status === NOT_AUTHORIZED) {
                await this.refreshToken();
                return this.getHomeCoachesData();
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
            const response = await fetch(`${this.API_BASE}api/gethomecoachsdata`, {
                method: 'POST',
                body
            });
            if(response.ok) {
                const data = await response.json(),
                    { body: devices } = data;
                if(Array.isArray(devices)) {
                    const d = findDevice(devices, this.device),
                        newDevice = formatDevice(d, 'coach');
                    let outdoorModule;
                    if(this.outdoorModule) {
                        const stations = await this.fetchStationData(this.outdoorModule.id),
                            rawOutdoorModule = findDevice(stations, this.outdoorModule);
                        outdoorModule = formatDevice(rawOutdoorModule, 'outdoor');
                    }
                    return this.setState(newDevice, true, outdoorModule);
                }
            }
            if(response.status === NOT_AUTHORIZED) {
                await this.refreshToken();
                return this.getHomeCoachData();
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
        async restoreState(stations) {
            const {
                device, outdoorModule
            } = await browser.storage.local.get([
                'device',
                'outdoorModule'
            ]);
            if(device) {
                const updatedDevice = stations?.stations.find((d) => isSameDevice(d, device)) || device;
                let updatedOutdoor;
                if(outdoorModule) {
                    updatedOutdoor = stations?.outdoorModules.find((m) => isSameDevice(m, outdoorModule)) || outdoorModule;
                }
                else if(stations?.outdoorModules.length) {
                    updatedOutdoor = stations.outdoorModules[FIRST];
                }
                await this.setState(updatedDevice, !outdoorModule, updatedOutdoor);
            }
            else if(stations?.stations.length) {
                let outdoor = outdoorModule;
                if(stations.outdoorModules.length && !outdoor) {
                    outdoor = stations.outdoorModules[FIRST];
                }
                let station;
                if(stations.stations.length) {
                    station = stations.stations[FIRST];
                }
                await this.setState(station, true, outdoor);
            }
        },
        async setState(device, store = true, outdoorModule) {
            const previousCO2 = this.device ? this.device.co2 : UNSET;
            this.device = device;
            this.outdoorModule = outdoorModule;
            if(store) {
                await browser.storage.local.set({
                    device,
                    outdoorModule
                });
            }
            if(this.device) {
                await Promise.all([
                    this.updateButton(),
                    this.showNotification(previousCO2)
                ]);
            }
        },
        getImage(boundaries) {
            if(!this.device) {
                return 'status/gray.svg';
            }
            if(this.device.co2 >= boundaries.red) {
                return 'status/red.svg';
            }
            else if(this.device.co2 >= boundaries.orange) {
                return 'status/orange.svg';
            }
            else if(this.device.co2 >= boundaries.yellow) {
                return 'status/yellow.svg';
            }
            else if(this.device.co2 > UNSET) {
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
            else if(this.device.co2 > UNSET && !onlyWarnTheme) {
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
            else if(this.device.co2 > UNSET) {
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
                windowBadge,
                alwaysWindowBadge
            } = await browser.storage.local.get({
                updateTheme: false,
                ppmOnBadge: false,
                onlyWarnTheme: false,
                boundaries: this.DEFAULT_BOUNDARIES,
                windowMin: this.DEFAULT_WINDOW_MIN,
                windowDelta: this.DEFAULT_WINDOW_DELTA,
                windowBadge: false,
                alwaysWindowBadge: false
            });
            await browser.browserAction.setIcon({
                path: this.getImage(boundaries)
            });
            await browser.browserAction.setTitle({
                title: this.device && this.device.co2 !== UNSET ? `${this.device.name}: ${this.device.co2}ppm` : 'Netatmo CO₂ Measurement'
            });
            let badgeText = '';
            if(windowBadge && this.outdoorModule && (this.device.co2 >= boundaries.yellow || alwaysWindowBadge) && this.device.temp >= windowMin && this.device.temp - this.outdoorModule.temp >= windowDelta) {
                if(this.device.co2 < FOUR_DIGITS) {
                    badgeText += '!';
                }
                else {
                    badgeText = '!';
                }
            }
            if(ppmOnBadge && this.device.co2 > UNSET) {
                badgeText += this.device.co2.toString(TEN);
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
                            frame: color
                        }
                    });
                }
                else {
                    browser.theme.reset();
                }
            }
        },
        async showNotification(previousCO2) {
            const canShow = await browser.permissions.contains({
                permissions: [ 'notifications' ]
            });
            if(canShow) {
                const message = `CO₂ now at ${this.device.co2}ppm`,
                    prefs = await browser.storage.local.get({
                        redNotification: false,
                        orangeNotification: false,
                        yellowNotification: false,
                        greenNotification: false,
                        boundaries: this.DEFAULT_BOUNDARIES,
                        windowDelta: this.DEFAULT_WINDOW_DELTA,
                        windowMin: this.DEFAULT_WINDOW_MIN
                    }),
                    iconUrl = this.getImage(prefs.boundaries),
                    notifSpec = {
                        message,
                        iconUrl,
                        type: 'basic'
                    };
                let shouldLowerCO2 = false;
                if(previousCO2 < prefs.boundaries.yellow && this.device.co2 >= prefs.boundaries.yellow && prefs.yellowNotification) {
                    notifSpec.title = `CO₂ level above ${prefs.boundaries.yellow}ppm`;
                    shouldLowerCO2 = true;
                }
                else if(previousCO2 < prefs.boundaries.orange && this.device.co2 >= prefs.boundaries.orange && prefs.orangeNotification) {
                    notifSpec.title = `CO₂ level above ${prefs.boundaries.orange}ppm`;
                    shouldLowerCO2 = true;
                }
                else if(previousCO2 < prefs.boundaries.red && this.device.co2 >= prefs.boundaries.red && prefs.redNotification) {
                    notifSpec.title = `CO₂ level above ${prefs.boundaries.red}ppm`;
                    shouldLowerCO2 = true;
                }
                else if(previousCO2 >= prefs.boundaries.yellow && this.device.co2 < prefs.boundaries.yellow && prefs.greenNotification) {
                    notifSpec.title = `CO₂ back to below ${prefs.boundaries.yellow}ppm`;
                }
                if(shouldLowerCO2 && this.outdoorModule && this.device.temp >= prefs.windowMin && this.device.temp - this.outdoorModule.temp >= prefs.windowDelta) {
                    notifSpec.message += ". Open a window, it's cooler outside!";
                }
                if(notifSpec.title) {
                    await browser.notifications.create(notifSpec);
                }
            }
        },
        async login() {
            const authState = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER).toString(HEX),
                scopes = 'read_station+read_homecoach',
                url = await browser.identity.launchWebAuthFlow({
                    url: `${this.API_BASE}oauth2/authorize?client_id=${clientToken}&redirect_uri=${this.redirectUri}&state=${authState}&scope=${scopes}`,
                    interactive: true
                }),
                parsedUrl = new URL(url);
            if(parsedUrl.searchParams.has('state') && parsedUrl.searchParams.get('state') === authState && parsedUrl.searchParams.has('code')) {
                const code = parsedUrl.searchParams.get('code'),
                    body = new URLSearchParams();
                body.append('scope', scopes.replace(/\+/g, ' '));
                body.append('code', code);
                body.append('grant_type', 'authorization_code');
                body.append('client_id', clientToken);
                body.append('client_secret', clientSecret);
                body.append('redirect_uri', this.redirectUri);
                const response = await fetch(`${this.API_BASE}oauth2/token`, {
                    method: 'POST',
                    body
                });
                if(response.ok) {
                    const data = await response.json();
                    await this.storeToken(data.access_token, data.expires_in * S_TO_MS, data.refresh_token);
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
            const p2 = this.setState(stripDevice(this.device), true, stripDevice(this.outdoorModule));
            return Promise.all([
                p,
                p2
            ]);
        },
        async getStationsList() {
            const [
                    weather,
                    healthcoach
                ] = await Promise.all([
                    this.getStationsData(),
                    this.getHomeCoachesData()
                ]),
                allDevices = healthcoach.concat(weather.stations);
            return {
                stations: allDevices,
                outdoorModules: weather.outdoorModules
            };
        },
        async init() {
            browser.alarms.onAlarm.addListener((alarm) => {
                if(alarm.name === this.REFRESH_ALARM) {
                    this.refreshToken().catch(console.error);
                }
                else if(alarm.name == this.UPDATE_ALARM && navigator.onLine) {
                    this.updateData().catch(console.error);
                }
            });
            browser.browserAction.onClicked.addListener(() => {
                browser.tabs.create({
                    url: 'https://my.netatmo.com'
                });
            });
            browser.storage.onChanged.addListener(async (changes, area) => {
                if(area === 'local') {
                    if(changes.hasOwnProperty('updateTheme') && changes.updateTheme.oldValue && !changes.updateTheme.newValue) {
                        browser.theme.reset();
                    }
                    if(changes.hasOwnProperty('device') && !isSameDevice(changes.device.newValue, changes.device.oldValue)) {
                        // Need to await so outdoor module doesn't clash with this.
                        await this.setState(changes.device.newValue, false, this.outdoorModule).catch(console.error);
                        this.ensureUpdateLoop();
                    }
                    if(changes.hasOwnProperty('outdoorModule') && !isSameDevice(changes.outdoorModule.newValue, changes.outdoorModule.oldValue)) {
                        await this.setState(this.device, false, changes.outdoorModule.newValue).catch(console.error);
                    }
                    // Don't have to udpate the button if the state has changed.
                    else if(this.device && (this.BUTTON_PREFS.some((p) => changes.hasOwnProperty(p)) || (changes.hasOwnProperty('updateTheme') && changes.updateTheme.newValue))) {
                        this.updateButton().catch(console.error);
                    }
                    if(changes.hasOwnProperty('interval') && this.hasUpdateLoop) {
                        try {
                            await browser.alarms.clear(this.UPDATE_ALARM);
                            if(changes.interval.newValue) {
                                browser.alarms.create(this.UPDATE_ALARM, {
                                    periodInMinutes: changes.interval.newValue
                                });
                            }
                        }
                        catch(error) {
                            console.error(error);
                        }
                    }
                    if(changes.hasOwnProperty('token') && !changes.token.newValue) {
                        this.reset().catch(console.error);
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
            const {
                token, expires
            } = await browser.storage.local.get([
                'token',
                'expires'
            ]);
            //TODO also wait for captive protal?!
            if(!navigator.onLine) {
                await waitForOnline();
            }
            if(!token) {
                try {
                    await this.login();
                }
                catch(error) {
                    console.warn("OAuth aborted");
                }
            }
            else {
                this.token = token;
                if(expires > Date.now()) {
                    this.scheduleRefresh(expires);
                    await this.ensureUpdateLoop();
                }
                else {
                    await this.restoreState();
                    await this.refreshToken();
                }
            }
            const hasNotifs = await browser.permissions.contains({
                    permissions: [ 'notifications' ]
                }),
                addListener = () => browser.notifications.onShown.addListener(() => {
                    browser.runtime.sendMessage("@notification-sound", "new-notification").catch(console.warn);
                });
            if(hasNotifs) {
                addListener();
            }
            else {
                const listener = (change) => {
                    if(change.permissions && change.permissions.includes('notifications')) {
                        addListener();
                        browser.permissions.onAdded.removeListener(listener);
                    }
                };
                browser.permissions.onAdded.addListener(listener);
            }
        }
    };
netatmo.init().catch(console.error);
