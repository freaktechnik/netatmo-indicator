"use strict";

const BOOLEAN_PREFS = [
    'updateTheme',
    'ppmOnBadge'
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

document.addEventListener('DOMContentLoaded', () => {
    const prefs = {};
    for(const id of BOOLEAN_PREFS) {
        prefs[id] = new BooleanPref(id);
    }
    browser.storage.local.get(BOOLEAN_PREFS).then((vals) => {
        for(const p in prefs) {
            if(prefs.hasOwnProperty(p)) {
                prefs[p].updateValue(!!vals[p]);
            }
        }
    });
}, {
    passive: true,
    once: true
});
