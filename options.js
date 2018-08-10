"use strict";

/* This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/.
 */

const BOOLEAN_PREFS = [
        'updateTheme',
        'ppmOnBadge',
        'onlyWarnTheme',
        'redNotification',
        'orangeNotification',
        'yellowNotification',
        'greenNotification',
        'windowBadge',
        'alwaysWindowBadge'
    ],

    NUMBER_PREFS = [
        'interval',
        'windowDelta',
        'windowMin'
    ],

    BOUNDARY_COLORS = [
        'red',
        'orange',
        'yellow'
    ],

    NOTIFICATION_PERM = {
        permissions: [ 'notifications' ]
    },

    showError = (error) => {
        let msg;
        if(error instanceof Error) {
            msg = error.message;
        }
        else {
            msg = error;
        }
        const errorPanel = document.getElementById("error");
        errorPanel.textContent = msg;
        errorPanel.hidden = false;
    },

    devices = browser.runtime.sendMessage('getstations');

class Pref {
    constructor(id, eventType = 'input', property = 'value') {
        this.input = document.getElementById(id);
        if(!this.input) {
            throw new Error(`input ${id} not found`);
        }
        this.property = property;
        this.id = id;
        this.defaultValue = this.getValue();

        this.input.addEventListener(eventType, () => {
            this.storeValue();
        }, {
            passive: true
        });
    }

    getValue() {
        return this.input[this.property];
    }

    storeValue() {
        browser.storage.local.set({
            [this.id]: this.getValue()
        }).catch(showError);
    }

    reset() {
        if(this.defaultValue !== undefined) {
            this.updateValue(this.defaultValue);
            this.storeValue();
        }
    }

    updateValue(val) {
        if(val !== undefined) {
            this.input[this.property] = val;
        }
    }
}

class BooleanPref extends Pref {
    constructor(id) {
        super(id, 'input', 'checked');
        if(id.endsWith('Notification')) {
            browser.permissions.contains(NOTIFICATION_PERM).then((hasPermission) => {
                if(!hasPermission) {
                    const requestPermission = () => {
                        if(this.input.checked) {
                            browser.permissions.request(NOTIFICATION_PERM).then((gotPermission) => {
                                if(!gotPermission) {
                                    throw new Error("Need notification permission to show notifications");
                                }
                                else {
                                    this.input.removeEventListener("click", requestPermission);
                                }
                            })
                                .catch(showError);
                        }
                    };
                    this.input.addEventListener('click', requestPermission, {
                        passive: true
                    });
                }
            })
                .catch(showError);
        }

        const nextSection = this.input.parentElement.nextElementSibling;
        this.childSection = undefined;
        if(nextSection && nextSection.tagName.toLowerCase() === 'section' && !nextSection.classList.contains('no-indent')) {
            this.childSection = nextSection;
        }
        this.updateSubsections();
    }

    updateSubsections() {
        if(this.childSection) {
            const disabled = !this.input.checked;
            this.childSection.classList.toggle('disabled', disabled);
            const inputs = this.childSection.querySelectorAll('input');
            if(inputs && inputs.length) {
                for(const input of inputs.values()) {
                    input.disabled = disabled;
                }
            }
        }
    }

    storeValue(...args) {
        this.updateSubsections();
        return super.storeValue(...args);
    }

    updateValue(val) {
        this.updateSubsections();
        super.updateValue(!!val);
    }
}

class NumberPref extends Pref {
    constructor(id) {
        super(id, 'input', 'valueAsNumber');
    }

    updateValue(val) {
        if(val !== undefined) {
            this.input.value = val;
        }
    }
}

class BoundaryPref {
    constructor() {
        this.boundaries = BOUNDARY_COLORS.map((c) => {
            const p = new NumberPref(c);
            p.storeValue = () => this.storeValue();
            return p;
        });
    }

    reset() {
        for(const boundary of this.boundaries) {
            boundary.reset();
        }
    }

    storeValue() {
        const boundaries = {};
        let prevValue = Infinity;
        for(const boundary of this.boundaries) {
            const value = boundary.getValue();
            boundary.input.max = prevValue;
            if(value > prevValue) {
                boundary.input.setCustomValidity("Must be smaller than the value of the previous color");
            }
            else {
                boundary.input.setCustomValidity("");
                prevValue = value;
            }
            boundaries[boundary.id] = value;
        }
        return browser.storage.local.set({
            boundaries
        }).catch(showError);
    }

    updateValue(val) {
        for(const boundary of this.boundaries) {
            if(val && val.hasOwnProperty(boundary.id)) {
                boundary.updateValue(val[boundary.id]);
            }
        }
    }
}

class StationsList extends Pref {
    static addToGroup(groups, group, option) {
        if(!groups.hasOwnProperty(group)) {
            groups[group] = document.createElement("optgroup");
            groups[group].setAttribute('label', group);
        }
        groups[group].append(option);
    }

    constructor(id, sourceName) {
        super(id, 'change');
        this.sourceName = sourceName;
    }

    getValue() {
        const val = super.getValue();
        if(val) {
            return JSON.parse(val);
        }
    }

    async fill(device = {}) {
        this.clear();
        const groups = {},
            { [this.sourceName]: stations } = await devices;
        for(const station of stations) {
            const selected = station.id === device.id && device.module_id == station.module_id,
                value = JSON.stringify(station),
                option = new Option(station.module, value, selected, selected);
            StationsList.addToGroup(groups, station.group, option);
        }
        for(const group of Object.values(groups)) {
            this.input.append(group);
        }
        this.input.disabled = false;
    }

    clear() {
        while(this.input.firstElementChild) {
            this.input.firstElementChild.remove();
        }
        this.input.disabled = true;
    }

    updateValue(val) {
        this.fill(val).catch(showError);
    }
}

class OutdoorList extends StationsList {
    constructor(id) {
        super(id, 'outdoorModules');
        devices.then((dev) => {
            document.getElementById("hasDelta").hidden = !dev.outdoorModules.length;
        })
            .catch(showError);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const prefs = {},
        login = document.getElementById("login");
    for(const id of BOOLEAN_PREFS) {
        prefs[id] = new BooleanPref(id);
    }
    for(const id of NUMBER_PREFS) {
        prefs[id] = new NumberPref(id);
    }
    prefs.boundaries = new BoundaryPref();
    prefs.device = new StationsList('device', 'stations');
    prefs.outdoorModule = new OutdoorList('outdoorModule');
    browser.storage.local.get(Object.keys(prefs).concat([ 'token' ])).then((vals) => {
        for(const p in prefs) {
            if(prefs.hasOwnProperty(p) && vals.hasOwnProperty(p) && (vals.token || (p !== 'device' && p !== 'outdoorModule'))) {
                prefs[p].updateValue(vals[p]);
            }
        }
        if(vals.token) {
            login.textContent = 'Logout';
        }
    })
        .catch(showError);

    login.addEventListener("click", async () => {
        const { token } = await browser.storage.local.get('token');
        if(token) {
            await browser.storage.local.set({
                token: undefined
            });
            login.textContent = 'Login';
            prefs.device.clear();
            prefs.outdoorModule.clear();
        }
        else {
            await browser.runtime.sendMessage('login').catch(showError);
            login.textContent = 'Logout';
            const {
                device, outdoorModule
            } = await browser.storage.local.get([
                'device',
                'outdoorModule'
            ]);
            await Promise.all([
                prefs.device.fill(device),
                prefs.outdoorModule.fill(outdoorModule)
            ]);
        }
    }, {
        passive: true
    });

    document.getElementById("reset").addEventListener("click", () => {
        for(const p in prefs) {
            if(prefs.hasOwnProperty(p)) {
                prefs[p].reset();
            }
        }
    }, {
        passive: true
    });
}, {
    passive: true,
    once: true
});
