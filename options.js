"use strict";

const BOOLEAN_PREFS = [
    'updateTheme',
    'ppmOnBadge',
    'onlyWarnTheme'
];

class BooleanPref {
    constructor(id) {
        this.input = document.getElementById(id);
        this.input.addEventListener('change', () => {
            browser.storage.local.set({
                [id]: this.input.checked
            });
        }, {
            passive: true
        });
    }

    updateValue(val) {
        this.input.checked = val;
    }
}

const showError = (error) => {
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
};

const clearStationList = () => {
    const stationList = document.getElementById("station");
    while(stationList.firstChildElement) {
        stationList.firstChildElement.remove();
    }
    stationList.disabled = true;
};

const addToGroup = (groups, group, node) => {
    if(!groups.hasOwnProperty(group)) {
        groups[group] = document.createElement("optgroup");
        groups[group].setAttribute('label', group);
    }
    groups[group].append(node);
};

const fillStationList = () => {
    Promise.all([
        browser.storage.local.get('device'),
        browser.runtime.sendMessage('getstations')
    ]).then(([ { device }, stations ]) => {
        clearStationList();
        const stationList = document.getElementById("station");
        const groups = {};
        for(const station of stations) {
            const selected = station.id === device.id && device.module_id == station.module_id;
            const value = JSON.stringify(station);
            const option = new Option(station.module, value, selected, selected);
            addToGroup(groups, station.group, option);
        }
        for(const group of Object.values(groups)) {
            stationList.append(group);
        }
        stationList.disabled = false;
    }).catch(showError);
};

document.addEventListener('DOMContentLoaded', () => {
    const prefs = {};
    const login = document.getElementById("login");
    const interval = document.getElementById("interval");
    for(const id of BOOLEAN_PREFS) {
        prefs[id] = new BooleanPref(id);
    }
    browser.storage.local.get(BOOLEAN_PREFS.concat([ 'token', 'interval' ])).then((vals) => {
        for(const p in prefs) {
            if(prefs.hasOwnProperty(p)) {
                prefs[p].updateValue(!!vals[p]);
            }
        }
        if(vals.token) {
            login.textContent = 'Logout';
            fillStationList();
        }
        if(vals.interval) {
            interval.value = vals.interval;
        }
    });

    login.addEventListener("click", async () => {
        const { token } = await browser.storage.local.get('token');
        if(token) {
            await browser.storage.local.set({
                token: undefined
            });
            login.textContent = 'Login';
            clearStationList();
        }
        else {
            await browser.runtime.sendMessage('login').catch(showError);
            login.textContent = 'Logout'
            fillStationList();
        }
    }, {
        passive: true
    });

    const stationList = document.getElementById("station");
    stationList.addEventListener('change', (e) => {
        browser.storage.local.set({
            device: JSON.parse(stationList.value)
        }).catch(console.error);
    }, {
        passive: true
    });

    interval.addEventListener("input", () => {
        browser.storage.local.set({
            interval: interval.valueAsNumber
        });
    }, {
        passive: true
    });
}, {
    passive: true,
    once: true
});
