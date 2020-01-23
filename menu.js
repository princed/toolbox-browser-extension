import 'regenerator-runtime/runtime';
import 'content-scripts-register-polyfill';
import {getAdditionalPermissions, getManifestPermissions} from 'webext-additional-permissions';

import {getFromStorage, removeFromStorage, saveToStorage} from './storage';

const MENU_ITEM_IDS = {
  PARENT_ID: 'jetbrains-toolbox-toggle-domain-parent',
  DOMAIN_GITHUB_ID: 'jetbrains-toolbox-toggle-domain-github',
  DOMAIN_GITLAB_ID: 'jetbrains-toolbox-toggle-domain-gitlab',
  DOMAIN_BITBUCKET_ID: 'jetbrains-toolbox-toggle-domain-bitbucket'
};

const CONTENT_SCRIPTS = {
  GITHUB: 'jetbrains-toolbox-github.js',
  GITLAB: 'jetbrains-toolbox-gitlab.js',
  BITBUCKET: 'jetbrains-toolbox-bitbucket-stash.js'
};

const CONTENT_SCRIPTS_BY_MENU_ITEM_IDS = {
  [MENU_ITEM_IDS.DOMAIN_GITHUB_ID]: CONTENT_SCRIPTS.GITHUB,
  [MENU_ITEM_IDS.DOMAIN_GITLAB_ID]: CONTENT_SCRIPTS.GITLAB,
  [MENU_ITEM_IDS.DOMAIN_BITBUCKET_ID]: CONTENT_SCRIPTS.BITBUCKET
};

const contentScriptUnregistrators = new Map();

let activeTabId = null;

function getTabUrl(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.get(tabId, tab => {
      if (chrome.runtime.lastError || tab == null || tab.url == null) {
        reject();
      } else {
        resolve(tab.url);
      }
    });
  });
}

function getDomain(url) {
  const parsedUrl = new URL(url);
  // domain should not include a port number:
  // https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Match_patterns
  return `${parsedUrl.protocol}//${parsedUrl.hostname}`;
}

function reloadTab(tabId) {
  chrome.tabs.executeScript(tabId, {
    code: 'window.location.reload()'
  }, () => chrome.runtime.lastError);
}

function createMenu() {
  const contexts = [
    chrome.contextMenus.ContextType.BROWSER_ACTION
  ];
  const documentUrlPatterns = [
    'http://*/*',
    'https://*/*'
  ];

  // keep calm and check the error
  // to not propagate it further
  chrome.contextMenus.remove(MENU_ITEM_IDS.PARENT_ID, () => chrome.runtime.lastError);
  chrome.contextMenus.create({
    id: MENU_ITEM_IDS.PARENT_ID,
    type: chrome.contextMenus.ItemType.NORMAL,
    title: 'Treat this domain as',
    contexts,
    documentUrlPatterns,
    enabled: false
  });
  chrome.contextMenus.create({
    parentId: MENU_ITEM_IDS.PARENT_ID,
    id: MENU_ITEM_IDS.DOMAIN_GITHUB_ID,
    type: chrome.contextMenus.ItemType.CHECKBOX,
    checked: false,
    title: 'github.com',
    contexts,
    documentUrlPatterns
  });
  chrome.contextMenus.create({
    parentId: MENU_ITEM_IDS.PARENT_ID,
    id: MENU_ITEM_IDS.DOMAIN_GITLAB_ID,
    type: chrome.contextMenus.ItemType.CHECKBOX,
    checked: false,
    title: 'gitlab.com',
    contexts,
    documentUrlPatterns
  });
  chrome.contextMenus.create({
    parentId: MENU_ITEM_IDS.PARENT_ID,
    id: MENU_ITEM_IDS.DOMAIN_BITBUCKET_ID,
    type: chrome.contextMenus.ItemType.CHECKBOX,
    checked: false,
    title: 'bitbucket.org',
    contexts,
    documentUrlPatterns
  });
}

function manifestPermissionGranted(url) {
  return new Promise((resolve, reject) => {
    getManifestPermissions().
      then(manifestPermissions => {
        const domain = getDomain(url);
        const granted = manifestPermissions.origins.some(p => p.startsWith(domain));
        if (granted) {
          resolve();
        } else {
          reject();
        }
      });
  });
}

function domainPermissionGranted(url) {
  return new Promise((resolve, reject) => {
    const permissions = generateDomainPermissions(url);
    chrome.permissions.contains(permissions, result => {
      if (result) {
        resolve();
      } else {
        reject();
      }
    });
  });
}

function generateDomainMatch(url) {
  const domain = getDomain(url);
  return `${domain}/*`;
}

function generateDomainPermissions(url) {
  return {
    origins: [generateDomainMatch(url)]
  };
}

function getContentScriptsByDomains() {
  return new Promise((resolve, reject) => {
    getAdditionalPermissions().
      then(permissions => {
        const additionalGrantedDomains = permissions.origins.map(getDomain);
        getFromStorage(additionalGrantedDomains).then(resolve).catch(reject);
      }).
      catch(reject);
  });
}

function updateMenuItem(id, updateProperties) {
  chrome.contextMenus.update(id, updateProperties);
}

function updateMenu(tabId) {
  getTabUrl(tabId).
    then(tabUrl => {
      manifestPermissionGranted(tabUrl).
        then(() => {
          updateMenuItem(MENU_ITEM_IDS.PARENT_ID, {enabled: false});
        }).
        catch(() => {
          domainPermissionGranted(tabUrl).
            then(() => {
              const domain = getDomain(tabUrl);
              getFromStorage(domain).
                then(contentScript => {
                  updateMenuItem(MENU_ITEM_IDS.PARENT_ID, {enabled: true});
                  switch (contentScript) {
                    case CONTENT_SCRIPTS.GITHUB:
                      updateMenuItem(MENU_ITEM_IDS.DOMAIN_GITHUB_ID, {checked: true});
                      updateMenuItem(MENU_ITEM_IDS.DOMAIN_GITLAB_ID, {checked: false});
                      updateMenuItem(MENU_ITEM_IDS.DOMAIN_BITBUCKET_ID, {checked: false});
                      break;
                    case CONTENT_SCRIPTS.GITLAB:
                      updateMenuItem(MENU_ITEM_IDS.DOMAIN_GITHUB_ID, {checked: false});
                      updateMenuItem(MENU_ITEM_IDS.DOMAIN_GITLAB_ID, {checked: true});
                      updateMenuItem(MENU_ITEM_IDS.DOMAIN_BITBUCKET_ID, {checked: false});
                      break;
                    case CONTENT_SCRIPTS.BITBUCKET:
                      updateMenuItem(MENU_ITEM_IDS.DOMAIN_GITHUB_ID, {checked: false});
                      updateMenuItem(MENU_ITEM_IDS.DOMAIN_GITLAB_ID, {checked: false});
                      updateMenuItem(MENU_ITEM_IDS.DOMAIN_BITBUCKET_ID, {checked: true});
                      break;
                    default:
                      updateMenuItem(MENU_ITEM_IDS.DOMAIN_GITHUB_ID, {checked: false});
                      updateMenuItem(MENU_ITEM_IDS.DOMAIN_GITLAB_ID, {checked: false});
                      updateMenuItem(MENU_ITEM_IDS.DOMAIN_BITBUCKET_ID, {checked: false});
                      break;
                  }
                }).
                catch(() => {
                  updateMenuItem(MENU_ITEM_IDS.PARENT_ID, {enabled: true});
                  updateMenuItem(MENU_ITEM_IDS.DOMAIN_GITHUB_ID, {checked: false});
                  updateMenuItem(MENU_ITEM_IDS.DOMAIN_GITLAB_ID, {checked: false});
                  updateMenuItem(MENU_ITEM_IDS.DOMAIN_BITBUCKET_ID, {checked: false});
                });
            }).
            catch(() => {
              updateMenuItem(MENU_ITEM_IDS.PARENT_ID, {enabled: true});
              updateMenuItem(MENU_ITEM_IDS.DOMAIN_GITHUB_ID, {checked: false});
              updateMenuItem(MENU_ITEM_IDS.DOMAIN_GITLAB_ID, {checked: false});
              updateMenuItem(MENU_ITEM_IDS.DOMAIN_BITBUCKET_ID, {checked: false});
            });
        });
    }).
    catch(() => {
      updateMenuItem(MENU_ITEM_IDS.PARENT_ID, {enabled: true});
      updateMenuItem(MENU_ITEM_IDS.DOMAIN_GITHUB_ID, {checked: false});
      updateMenuItem(MENU_ITEM_IDS.DOMAIN_GITLAB_ID, {checked: false});
      updateMenuItem(MENU_ITEM_IDS.DOMAIN_BITBUCKET_ID, {checked: false});
    });
}

function toggleDomainPermissions(request, url) {
  return new Promise((resolve, reject) => {
    const permissions = generateDomainPermissions(url);
    const updatePermissions = request ? chrome.permissions.request : chrome.permissions.remove;
    updatePermissions(permissions, success => {
      if (success) {
        resolve();
      } else {
        reject();
      }
    });
  });
}

function handleMenuItemClick(info, tab) {
  if (info.menuItemId !== MENU_ITEM_IDS.DOMAIN_GITHUB_ID &&
    info.menuItemId !== MENU_ITEM_IDS.DOMAIN_GITLAB_ID &&
    info.menuItemId !== MENU_ITEM_IDS.DOMAIN_BITBUCKET_ID) {
    return;
  }
  if (tab.url.startsWith('chrome://')) {
    updateMenu(tab.id);
    return;
  }
  manifestPermissionGranted(tab.url).
    then(() => {
      // if manifest permissions for domain are granted then the extension menu must be disabled.
      // if it's enabled then it could be the case when extension is disabled until it/its menu is clicked.
      // if this is the case then the extension is enabled at the moment, let's try to update the menu.
      updateMenu(tab.id);
    }).
    catch(() => {
      const requestPermissions = info.checked;
      toggleDomainPermissions(requestPermissions, tab.url).
        then(() => {
          const domain = getDomain(tab.url);
          if (requestPermissions) {
            const domainMatch = generateDomainMatch(domain);
            const contentScriptOptions = {
              matches: [domainMatch],
              js: [
                {file: CONTENT_SCRIPTS_BY_MENU_ITEM_IDS[info.menuItemId]}
              ]
            };
            // implementation of chrome.contentScripts.register doesn't work as expected in FF
            // (returns promise which doesn't resolve soon)
            (window.browser || window.chrome).contentScripts.register(contentScriptOptions).
              then(newUnregistrator => {
                if (contentScriptUnregistrators.has(domain)) {
                  const prevUnregistrator = contentScriptUnregistrators.get(domain);
                  prevUnregistrator.unregister();
                }
                contentScriptUnregistrators.set(domain, newUnregistrator);
                saveToStorage(domain, CONTENT_SCRIPTS_BY_MENU_ITEM_IDS[info.menuItemId]).then(() => {
                  reloadTab(tab.id);
                });
              });
          } else {
            const unregistrator = contentScriptUnregistrators.get(domain);
            unregistrator.unregister();
            contentScriptUnregistrators.delete(domain);
            removeFromStorage(domain).then(() => {
              reloadTab(tab.id);
            });
          }
        }).
        catch(() => {
          updateMenuItem(info.menuItemId, {checked: !requestPermissions});
        });
    });
}

function handleTabActivated(activeInfo) {
  activeTabId = activeInfo.tabId;
  updateMenu(activeInfo.tabId);
}

function handleTabUpdated(tabId, changeInfo) {
  if (activeTabId === tabId && changeInfo.status === 'complete') {
    updateMenu(tabId);
  }
}

export function createExtensionMenu() {
  // update menu items according to granted permissions (make checked, disabled, etc.)
  chrome.tabs.onActivated.addListener(handleTabActivated);
  chrome.tabs.onUpdated.addListener(handleTabUpdated);
  // request or remove permissions
  chrome.contextMenus.onClicked.addListener(handleMenuItemClick);

  getContentScriptsByDomains().then(result => {
    Object.keys(result).forEach(domain => {
      const domainMatch = generateDomainMatch(domain);
      (window.browser || window.chrome).contentScripts.
        register({
          matches: [domainMatch],
          js: [
            {file: result[domain]}
          ]
        }).
        then(unregistrator => {
          contentScriptUnregistrators.set(domain, unregistrator);
        });
    });
    createMenu();
  });
}
