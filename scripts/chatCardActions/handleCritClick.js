/* global ui, Roll, ChatMessage */
import { socket } from "../dcc-qol.js";

/**
 * Handles the click event for the "Roll Critical" button on the QoL attack card.
 *
 * @param {Event} event - The click event.
 * @param {ChatMessage} message - The chat message document associated with the card.
 * @param {Actor} actor - The actor performing the action.
 * @param {Item} weapon - The weapon item used.
 * @param {object} qolFlags - The dccqol flags from the message.
 */
export async function handleCritClick(event, message, actor, weapon, qolFlags) {
    event.preventDefault();
    // console.log("DCC-QOL | Crit button clicked via handleCritClick", { messageSystem: message.system, actor, weapon, qolFlags });

    if (!message.system || !message.system.critRollFormula) {
        console.error(
            "DCC-QOL | Critical roll formula not found in message.system",
            message
        );
        ui.notifications.error(
            "DCC QoL: Critical roll formula not found in the original message data!"
        );
        return;
    }

    if (!actor) {
        console.error(
            "DCC-QOL | Actor not available for critical roll processing. Message ID:",
            message.id
        );
        ui.notifications.error(
            "DCC QoL: Actor context not found for critical roll."
        );
        return;
    }

    try {
        const rollModifierDefault = game.settings.get(
            "dcc",
            "showRollModifierByDefault"
        );
        const showModifierDialog =
            rollModifierDefault ^ (event.ctrlKey || event.metaKey);

        let flavorText = `Critical Hit (Table ${
            message.system.critTableName || "Unknown"
        })`; // Fallback flavor
        if (message.system.critInlineRoll) {
            try {
                const tempDiv = document.createElement("div");
                tempDiv.innerHTML = message.system.critInlineRoll;
                const anchorTag = tempDiv.querySelector("a.inline-roll");
                if (anchorTag && anchorTag.dataset.flavor) {
                    flavorText = anchorTag.dataset.flavor;
                }
            } catch (e) {
                console.warn(
                    "DCC-QOL | Could not parse critInlineRoll for flavor, using fallback.",
                    e
                );
            }
        }

        const roll = await game.dcc.DCCRoll.createRoll(
            [
                {
                    type: "Compound",
                    formula: message.system.critRollFormula,
                },
            ],
            actor.getRollData(),
            {
                showModifierDialog,
                rollLabel: game.i18n.localize("DCC.RollCritical"),
                title: game.i18n.localize("DCC.Critical"),
                window: { title: game.i18n.localize("DCC.Critical") },
            }
        );
        await roll.evaluate();

        await roll.toMessage({
            speaker: ChatMessage.getSpeaker({ actor: actor }),
            flavor: flavorText,
            flags: {
                "dcc.RollType": "Crit", // System flag for critical hit rolls
                "dccqol.isCritRoll": true,
                "dccqol.parentId": message.id,
                "dccqol.actorId": actor.id,
                "dccqol.weaponId": weapon?.id || qolFlags.weaponId,
                "dccqol.critTableName": message.system.critTableName,
            },
        });

        // Update the original message to mark that crit button was clicked
        // This will cause all clients to re-render with the button disabled
        // Use socket to have GM update the flags since players can't modify message flags
        try {
            await socket.executeAsGM("gmUpdateMessageFlags", {
                messageId: message.id,
                flagScope: "dcc-qol",
                flags: {
                    critButtonClicked: true,
                },
            });
        } catch (flagError) {
            console.warn(
                "DCC-QOL | Could not update crit button clicked flag:",
                flagError
            );
            // Don't throw here - the crit roll was successful even if flag update failed
        }
    } catch (rollError) {
        console.error("DCC-QOL | Error performing critical roll:", rollError, {
            formula: message.system.critRollFormula,
            actorData: actor.getRollData(),
        });
        ui.notifications.error(
            `DCC QoL: Error performing critical roll - ${rollError.message}`
        );
    }
}
