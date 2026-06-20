/**
 * Handles Foundry VTT hooks related to chat message rendering and interaction.
 * This typically involves modifying the HTML of a chat message before it's displayed
 * or attaching event listeners to elements within a rendered chat message.
 */
/* global game, canvas, Hooks, ChatMessage */

// V13 namespace import for renderTemplate
const { renderTemplate } = foundry.applications.handlebars;
import { getWeaponProperties, getWeaponFromActorById } from "../utils.js"; // Import the utility function
import { handleDamageClick } from "../chatCardActions/handleDamageClick.js";
import { handleCritClick } from "../chatCardActions/handleCritClick.js";
import { handleFumbleClick } from "../chatCardActions/handleFumbleClick.js";
import { handleFriendlyFireClick } from "../chatCardActions/handleFriendlyFireClick.js";

/**
 * Replaces the content of DCC attack roll chat cards with a custom QoL template.
 * Called via the renderChatMessageHTML hook.
 * Assumes data has been prepared by the dcc.rollWeaponAttack hook.
 *
 * @param {ChatMessage} message - The ChatMessage document being rendered.
 * @param {HTMLElement} html - The DOM element representing the message's HTML content. (V13: was jQuery in V12)
 * @param {object} data - The data object provided to the hook (includes original message content).
 */
export async function enhanceAttackRollCard(message, html, data) {
    // Quick check for QoL setting and our specific flag
    const qolFlags = message.flags?.dccqol;
    if (!qolFlags) {
        return;
    }
    // Handle QoL Attack Card enhancement
    if (
        qolFlags.isAttackRoll &&
        game.settings.get("dcc-qol", "useQoLAttackCard")
    ) {
        try {
            // --- Fetch Actor (Simplified) ---
            let actor;
            const speaker = message.speaker;
            const actorIdForContext = qolFlags?.actorId; // For logging if needed

            // Try to get actor from the token speaker first
            if (speaker.token && speaker.scene) {
                const tokenDocument = game.scenes
                    .get(speaker.scene)
                    ?.tokens.get(speaker.token);
                if (tokenDocument) {
                    actor = tokenDocument.actor;
                }
            }

            // If no actor from token speaker, fallback to general speaker actor resolution
            if (!actor) {
                actor = ChatMessage.getSpeakerActor(speaker);
            }

            // Final check if an actor was determined
            if (!actor) {
                console.warn(
                    `DCC-QOL | Actor could not be determined for message ${message.id}. Speaker details - Token: ${speaker.token}, Scene: ${speaker.scene}, Actor: ${speaker.actor}. Associated qolFlags.actorId: ${actorIdForContext}`
                );
                return; // Can't get weapon without actor
            }

            // --- Fetch Weapon FROM ACTOR using utility function ---
            const weapon = getWeaponFromActorById(actor, qolFlags.weaponId);
            if (!weapon) {
                return;
            }

            // --- Extract Original Roll HTML ---
            // V13: Remove jQuery HTML parsing - not needed for current logic
            // const originalContent = $(`<div>${message.content}</div>`); // Use message.content

            // Check the attack card format setting to determine dice HTML format
            const attackCardFormat = game.settings.get(
                "dcc-qol",
                "attackCardFormat"
            );

            let diceHTML = "";
            if (
                attackCardFormat === "compact" &&
                message.rolls &&
                message.rolls[0]
            ) {
                // Use compact format with toAnchor().outerHTML for compact cards
                diceHTML = message.rolls[0].toAnchor().outerHTML;
            } else {
                // Use full dice roll HTML for standard cards
                diceHTML = await message.rolls[0].render();
            }

            // --- Get Weapon Properties ---
            const properties = await getWeaponProperties(
                weapon,
                qolFlags.options || {}
            );

            // --- Build the Mighty Deed table prompt (if any) ---
            // The DCC system renders a "Roll Deed" prompt on its own attack card
            // when a warrior's/dwarf's deed die succeeds and Mighty Deed tables
            // are configured. Because we replace .message-content wholesale, we
            // must render the identical prompt ourselves. game.dcc exposes the
            // markup builder (and the listener attach below) so the lookup logic
            // stays owned by the system. Guarded for older system versions.
            const deedPromptHTML =
                game.dcc?.buildMightyDeedPrompt?.(message) || "";

            // --- Prepare Template Data ---
            const templateData = {
                ...qolFlags, // Includes deedDieResult and now isPC from flags
                actor: actor,
                weapon: weapon,
                diceHTML: diceHTML, // Pass the extracted attack roll HTML
                deedPromptHTML: deedPromptHTML, // Mighty Deed prompt markup (or "")
                properties: properties,
                messageId: message.id,
                // Add attack card format setting for template logic
                attackCardFormat: attackCardFormat,
                // Add permission checking per-client
                canUserModify: actor.canUserModify(game.user, "update"),
                isGM: game.user.isGM,
                damageButtonClicked:
                    message.getFlag("dcc-qol", "damageButtonClicked") || false,
                damageTotal: message.getFlag("dcc-qol", "damageTotal") || null,
                fumbleButtonClicked:
                    message.getFlag("dcc-qol", "fumbleButtonClicked") || false,
                critButtonClicked:
                    message.getFlag("dcc-qol", "critButtonClicked") || false,
                friendlyFireButtonClicked:
                    message.getFlag("dcc-qol", "friendlyFireButtonClicked") ||
                    false,
            };

            // --- Render the Custom Template ---
            // Check the attack card format setting to determine which template to use
            const templatePath =
                attackCardFormat === "compact"
                    ? "modules/dcc-qol/templates/attackroll-card-compact.html"
                    : "modules/dcc-qol/templates/attackroll-card.html";

            const renderedContentHtml = await renderTemplate(
                templatePath,
                templateData
            );

            // --- Modify existing message elements ---
            const messageHeader = html.querySelector(".message-header");
            if (messageHeader) {
                // Remove the specific flavor text span
                const flavorSpan =
                    messageHeader.querySelector("span.flavor-text");
                if (flavorSpan) flavorSpan.remove();

                // Add a custom class to the sender for styling
                const senderH4 =
                    messageHeader.querySelector("h4.message-sender");
                if (senderH4) senderH4.classList.add("dccqol-speaker-name");
            }

            // Replace the content of the .message-content div with our card
            const messageContentElement =
                html.querySelector(".message-content");
            if (messageContentElement) {
                messageContentElement.innerHTML = renderedContentHtml;
            } else {
                // Fallback if .message-content wasn't found (should be rare for standard messages)
                console.warn(
                    "DCC-QOL | .message-content not found. Appending card to main message element (li)."
                );
                html.insertAdjacentHTML("beforeend", renderedContentHtml);
            }

            // --- Add Event Listeners for QoL Card Buttons ---
            // Determine the correct element to attach listeners to (either the specific .message-content div or the whole html if .message-content wasn't found)
            const cardElement = messageContentElement || html;

            // Wire up the Mighty Deed table prompt we rendered above. The system
            // owns the lookup handler; we just (re)attach it to our rebuilt card.
            // Safe no-op when the prompt isn't present or on older systems.
            game.dcc?.attachMightyDeedListeners?.(message, cardElement);

            const damageButton = cardElement.querySelector(
                'button[data-action="damage"]'
            );
            if (damageButton) {
                damageButton.addEventListener("click", (event) =>
                    handleDamageClick(event, message, actor, weapon, qolFlags)
                );
            }

            const critButton = cardElement.querySelector(
                'button[data-action="crit"]'
            );
            if (critButton) {
                critButton.addEventListener("click", (event) =>
                    handleCritClick(event, message, actor, weapon, qolFlags)
                );
            }

            const fumbleButton = cardElement.querySelector(
                'button[data-action="fumble"]'
            );
            if (fumbleButton) {
                fumbleButton.addEventListener("click", (event) =>
                    handleFumbleClick(event, message, actor, weapon, qolFlags)
                );
            }

            const friendlyFireButton = cardElement.querySelector(
                'button[data-action="friendlyFire"]'
            );
            if (friendlyFireButton) {
                friendlyFireButton.addEventListener("click", (event) =>
                    handleFriendlyFireClick(event, message, actor, qolFlags)
                );
            }

            // Add event listener for weapon image click to toggle description
            const weaponImage = cardElement.querySelector(
                '.weapon-image-clickable[data-action="toggle-weapon-description"]'
            );
            if (weaponImage) {
                weaponImage.addEventListener("click", (event) => {
                    event.preventDefault();
                    const weaponId =
                        weaponImage.closest(".dccqol.chat-card")?.dataset
                            .weaponId;
                    if (weaponId) {
                        const descriptionElement = cardElement.querySelector(
                            `[data-weapon-description="${weaponId}"]`
                        );
                        if (descriptionElement) {
                            descriptionElement.classList.toggle(
                                "dcc-qol-hidden"
                            );
                        }
                    }
                });
            }

            // Add event listener for weapon name click to toggle description
            const weaponName = cardElement.querySelector(
                '.weapon-name-clickable[data-action="toggle-weapon-description"]'
            );
            if (weaponName) {
                weaponName.addEventListener("click", (event) => {
                    event.preventDefault();
                    const weaponId =
                        weaponName.closest(".dccqol.chat-card")?.dataset
                            .weaponId;
                    if (weaponId) {
                        const descriptionElement = cardElement.querySelector(
                            `[data-weapon-description="${weaponId}"]`
                        );
                        if (descriptionElement) {
                            descriptionElement.classList.toggle(
                                "dcc-qol-hidden"
                            );
                        }
                    }
                });
            }

            // --- Apply Dice Roll Status Coloring for Hits/Misses/Crits/Fumbles ---
            const diceTotalElement = cardElement.querySelector(
                ".dice-roll .dice-total"
            );
            if (diceTotalElement) {
                if (qolFlags.isCrit) {
                    diceTotalElement.classList.add("critical");
                } else if (qolFlags.isFumble) {
                    diceTotalElement.classList.add("fumble");
                } else if (qolFlags.target) {
                    // Only apply hit/miss if it's a targeted roll and not a crit/fumble
                    if (qolFlags.hitsTarget) {
                        diceTotalElement.classList.add("status-success");
                    } else {
                        diceTotalElement.classList.add("status-failure");
                    }
                }
            }
        } catch (err) {
            console.error(
                "DCC QoL | Error enhancing attack roll card:",
                err,
                message.id,
                qolFlags
            );
        }
    } // End of Attack Roll specific enhancements

    // Handle QoL Friendly Fire Cards - Re-render with per-client permissions
    if (qolFlags.isFriendlyFireCheck) {
        try {
            // Get actor for permission checks
            let actor;
            const speaker = message.speaker;

            // Try to get actor from the token speaker first
            if (speaker.token && speaker.scene) {
                const tokenDocument = game.scenes
                    .get(speaker.scene)
                    ?.tokens.get(speaker.token);
                if (tokenDocument) {
                    actor = tokenDocument.actor;
                }
            }

            // If no actor from token speaker, fallback to general speaker actor resolution
            if (!actor) {
                actor = ChatMessage.getSpeakerActor(speaker);
            }

            // Final fallback to qolFlags.actorId
            if (!actor && qolFlags.actorId) {
                actor = game.actors.get(qolFlags.actorId);
            }

            if (!actor) {
                console.warn(
                    `DCC-QOL | Actor could not be determined for friendly fire message ${message.id}`
                );
                return;
            }

            // Only re-render if this is a friendly fire hit that needs damage button functionality
            if (
                !qolFlags.noFriendlyFireActuallyOccurred &&
                qolFlags.friendlyFireHit
            ) {
                // Get weapon for the friendly fire damage
                const weapon = getWeaponFromActorById(actor, qolFlags.weaponId);
                if (!weapon) {
                    console.warn(
                        `DCC-QOL | Weapon could not be found for friendly fire message ${message.id}`
                    );
                    return;
                }

                // Get both the d100 and attack roll HTML from stored flags (more reliable than DOM extraction)
                const d100RollHTML = qolFlags.d100RollHTML || "";
                const attackRollHTML = qolFlags.attackRollHTML || "";

                // Get weapon properties
                const properties = await getWeaponProperties(
                    weapon,
                    qolFlags.options || {}
                );

                // Prepare template data with per-client permissions
                const templateData = {
                    actor: actor,
                    tokenId: qolFlags.tokenId,
                    weapon: weapon,
                    target: qolFlags.target,
                    targetTokenId: qolFlags.targetTokenId,
                    d100RollHTML: d100RollHTML,
                    attackRollHTML: attackRollHTML,
                    hit: qolFlags.friendlyFireHit,
                    noFriendlyFireOccurred:
                        qolFlags.noFriendlyFireActuallyOccurred || false,
                    hitText: qolFlags.hitText || "",
                    missText: qolFlags.missText || "",
                    struckAllyText: qolFlags.struckAllyText || "",
                    friendlyFireSafeText: qolFlags.friendlyFireSafeText || "",
                    properties: properties,
                    // Add damage formula for display in button
                    damageRollFormula: weapon?.system?.damage,
                    // Per-client permission checks
                    canUserModify: actor.canUserModify(game.user, "update"),
                    isGM: game.user.isGM,
                    damageButtonClicked:
                        message.getFlag("dcc-qol", "damageButtonClicked") ||
                        false,
                    damageTotal:
                        message.getFlag("dcc-qol", "damageTotal") || null,
                };

                // Re-render the friendly fire card with per-client permissions
                const renderedContentHtml = await renderTemplate(
                    "modules/dcc-qol/templates/friendly-fire-card.html",
                    templateData
                );

                // Replace the content
                const messageContentElement =
                    html.querySelector(".message-content");
                if (messageContentElement) {
                    messageContentElement.innerHTML = renderedContentHtml;
                } else {
                    console.warn(
                        "DCC-QOL | .message-content not found for friendly fire card. Appending to main message element."
                    );
                    html.insertAdjacentHTML("beforeend", renderedContentHtml);
                }

                // Add event listener for the damage button
                const cardElement = messageContentElement || html;
                const damageButton = cardElement.querySelector(
                    'button[data-action="damage"]'
                );
                if (damageButton) {
                    damageButton.addEventListener("click", (event) =>
                        handleDamageClick(
                            event,
                            message,
                            actor,
                            weapon,
                            qolFlags
                        )
                    );
                }

                console.debug(
                    "DCC-QOL | Re-rendered friendly fire card with per-client permissions for message",
                    message.id
                );
            } else {
                // Handle all friendly fire cases (both hit and safe) with re-rendering
                // This ensures consistent per-client rendering even for safe cases

                // Get d100 roll HTML from stored flags (more reliable than DOM extraction)
                const d100RollHTML = qolFlags.d100RollHTML || "";
                const attackRollHTML = qolFlags.attackRollHTML || ""; // Usually empty for safe cases

                // Get weapon and properties (if weapon exists)
                let weapon = null;
                let properties = [];
                if (qolFlags.weaponId) {
                    weapon = getWeaponFromActorById(actor, qolFlags.weaponId);
                    if (weapon) {
                        properties = await getWeaponProperties(
                            weapon,
                            qolFlags.options || {}
                        );
                    }
                }

                // Prepare template data for non-hit cases (safe or miss)
                const templateData = {
                    actor: actor,
                    tokenId: qolFlags.tokenId,
                    weapon: weapon,
                    target: qolFlags.target,
                    targetTokenId: qolFlags.targetTokenId,
                    d100RollHTML: d100RollHTML,
                    attackRollHTML: attackRollHTML,
                    hit: qolFlags.friendlyFireHit || false,
                    noFriendlyFireOccurred:
                        qolFlags.noFriendlyFireActuallyOccurred || false,
                    hitText: qolFlags.hitText || "",
                    missText: qolFlags.missText || "",
                    struckAllyText: qolFlags.struckAllyText || "",
                    friendlyFireSafeText: qolFlags.friendlyFireSafeText || "",
                    properties: properties,
                    // Add damage formula for display in button
                    damageRollFormula: weapon?.system?.damage,
                    canUserModify:
                        actor.canUserModify(game.user, "update") ||
                        game.user.isGM,
                    isGM: game.user.isGM,
                    damageButtonClicked: false, // No damage button for safe/miss cases
                    damageTotal: null,
                };

                // Re-render the friendly fire card
                const renderedContentHtml = await renderTemplate(
                    "modules/dcc-qol/templates/friendly-fire-card.html",
                    templateData
                );

                // Replace the content
                const messageContentElement =
                    html.querySelector(".message-content");
                if (messageContentElement) {
                    messageContentElement.innerHTML = renderedContentHtml;
                } else {
                    html.insertAdjacentHTML("beforeend", renderedContentHtml);
                }
            }
        } catch (err) {
            console.error(
                "DCC QoL | Error re-rendering friendly fire card:",
                err,
                message.id
            );
        }
    } // End of Friendly Fire card re-rendering

    // Legacy friendly fire damage button setup (kept for backwards compatibility)
    if (qolFlags.isFriendlyFireCheck && qolFlags.friendlyFireHit) {
        try {
            // This section is now redundant due to the re-rendering above,
            // but keeping it as a fallback for any edge cases
            let actor;
            const speaker = message.speaker;

            if (speaker.token && speaker.scene) {
                const tokenDocument = game.scenes
                    .get(speaker.scene)
                    ?.tokens.get(speaker.token);
                if (tokenDocument) {
                    actor = tokenDocument.actor;
                }
            }

            if (!actor) {
                actor = ChatMessage.getSpeakerActor(speaker);
            }

            if (!actor && qolFlags.actorId) {
                actor = game.actors.get(qolFlags.actorId);
            }

            if (actor) {
                const weapon = getWeaponFromActorById(actor, qolFlags.weaponId);
                if (weapon) {
                    // Only add if not already added by re-rendering above
                    const existingDamageButton = html.querySelector(
                        'button[data-action="damage"]'
                    );
                    if (!existingDamageButton) {
                        const damageButton = html.querySelector(
                            'button[data-action="damage"]'
                        );
                        if (damageButton) {
                            damageButton.addEventListener("click", (event) =>
                                handleDamageClick(
                                    event,
                                    message,
                                    actor,
                                    weapon,
                                    qolFlags
                                )
                            );
                        }
                    }
                }
            }
        } catch (err) {
            console.error(
                "DCC QoL | Error in legacy friendly fire damage button setup:",
                err,
                message.id
            );
        }
    }
}

/**
 * Adds a specific CSS class to non-QoL chat messages if the 'useQoLAttackCard' setting is enabled.
 * This allows for applying a consistent base font style to system messages.
 * @param {ChatMessage} message - The ChatMessage document.
 * @param {HTMLElement} html - The DOM element for the message's HTML. (V13: was jQuery in V12)
 * @param {object} data - Additional data related to the message.
 */
export const styleSystemChatCard = (message, html, data) => {
    if (game.settings.get("dcc-qol", "useQoLAttackCard")) {
        // html is the DOM element for the outer .chat-message element.
        // QoL cards have .dccqol.chat-card class usually on a direct child of .message-content or similar.
        // We check if such a card exists within the current message's HTML.
        const qolCard = html.querySelector(".dccqol.chat-card");

        if (!qolCard) {
            // If no .dccqol.chat-card is found, it's not a QoL card,
            // so we add our class to the main message element for font styling.
            html.classList.add("dccqol-system-card-font");
        }
    }
};
