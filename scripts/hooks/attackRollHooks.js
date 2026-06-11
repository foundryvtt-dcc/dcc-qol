/**
 * Handles Foundry VTT hooks related to the data generation and mechanics of attack rolls.
 * This includes modifying roll terms, preparing data before a chat message is created,
 * or reacting to events within the attack sequence itself.
 */
import {
    getFirstTarget,
    checkFiringIntoMelee,
    getTokensInMeleeRange,
    getWeaponFromActorById,
    measureTokenDistance,
    getTokenById,
    getTokenDocumentFromActor,
} from "../utils.js";

/**
 * Test Listener for the dcc.modifyAttackRollTerms hook.
 * Adds a bonus based on the length of the target's name.
 * @param {Array} terms - The array of roll terms.
 * @param {Actor} actor - The attacking actor.
 * @param {Item} weapon - The weapon item used.
 * @param {TokenDocument | TokenDocument[] | undefined} targets - The target(s) passed by the hook.
 * @param {object} options - Roll options.
 */
export function addTestBonus(terms, actor, weapon, targets, options) {
    console.debug("DCC-QOL | addTestBonus hook listener called");
    console.log("DCC-QOL Hook | dcc.modifyAttackRollTerms triggered!");
    console.log(
        "DCC-QOL Hook | Initial terms:",
        JSON.parse(JSON.stringify(terms))
    ); // Log initial terms
    console.log("DCC-QOL Hook | Targets received:", targets); // Log received targets

    // Determine the first valid target document
    let targetDocument = undefined;
    if (targets instanceof Set && targets.size > 0) {
        // Standard Foundry target Set<Token>
        targetDocument = targets.first()?.document; // Get the document from the first Token
    }

    if (targetDocument?.name) {
        const targetName = targetDocument.name;
        const weirdBonusValue = targetName.length;
        console.log(
            `DCC-QOL Hook | Target: ${targetName}, Name Length: ${weirdBonusValue}`
        );

        // Add the new modifier term
        terms.push({
            type: "Modifier",
            label: "Weird Bonus", // Translate if needed: game.i18n.localize("DCC-QOL.WeirdBonusLabel")
            formula: "+" + weirdBonusValue.toString(), // Ensure formula is a string
        });

        console.log("DCC-QOL Hook | Final terms:", terms); // Log terms after modification
    } else {
        console.log(
            "DCC-QOL Hook | No valid target document found in the Set."
        );
    }
}

/**
 * Modifies the fumbleRollFormula and fumbleInlineRoll in messageData if a fumble occurs
 * against a Player Character, based on the target PC's Luck modifier.
 *
 * @param {object} messageData - The chat message data object.
 * @param {boolean} isFumble - Whether the current attack is a fumble.
 * @param {Actor} targetActor - The actor being targeted.
 */
export function _modifyFumbleDieForTargetPCLuck(
    messageData,
    isFumble,
    targetActor
) {
    if (isFumble && targetActor && targetActor.type === "Player") {
        const targetLuckMod = targetActor.system.abilities?.lck?.mod;
        if (typeof targetLuckMod === "number") {
            const baseFumbleDie = "1d10"; // Per requirement: 0 luck mod = 1d10 base for this mechanic
            const newFumbleDie = game.dcc.DiceChain.bumpDie(
                baseFumbleDie,
                targetLuckMod.toString()
            );

            if (newFumbleDie) {
                messageData.system.fumbleRollFormula = newFumbleDie;
                console.debug(
                    `DCC-QOL | _modifyFumbleDieForTargetPCLuck: Set messageData.system.fumbleRollFormula to ${newFumbleDie} for target PC ${targetActor.name} (Luck Mod: ${targetLuckMod}).`
                );
                // Removed modification of messageData.system.fumbleInlineRoll as per user feedback
            } else {
                console.debug(
                    `DCC-QOL | _modifyFumbleDieForTargetPCLuck: newFumbleDie was not generated for target PC ${targetActor.name}.`
                );
            }
        } else {
            console.debug(
                `DCC-QOL | _modifyFumbleDieForTargetPCLuck: Target PC ${targetActor.name} luck mod is not a number.`
            );
        }
    }
}

/**
 * Modifies the critRollFormula in messageData if a critical hit occurs
 * against a Player Character, applying the target PC's Luck modifier as a penalty.
 *
 * @param {object} messageData - The chat message data object.
 * @param {boolean} isCrit - Whether the current attack is a critical hit.
 * @param {Actor} targetActor - The actor being targeted.
 */
export function _modifyCritRollForTargetPCLuck(
    messageData,
    isCrit,
    targetActor
) {
    if (isCrit && targetActor && targetActor.type === "Player") {
        const targetLuckMod = targetActor.system.abilities?.lck?.mod;
        if (typeof targetLuckMod === "number" && targetLuckMod !== 0) {
            const currentCritFormula = messageData.system.critRollFormula || "";

            if (currentCritFormula) {
                // Apply the inverse of the target's luck modifier as a penalty
                const luckPenalty = -targetLuckMod;
                const newCritFormula =
                    currentCritFormula +
                    (luckPenalty >= 0 ? `+${luckPenalty}` : `${luckPenalty}`);

                messageData.system.critRollFormula = newCritFormula;
                console.debug(
                    `DCC-QOL | _modifyCritRollForTargetPCLuck: Modified critRollFormula from "${currentCritFormula}" to "${newCritFormula}" for target PC ${targetActor.name} (Luck Mod: ${targetLuckMod}, Applied Penalty: ${luckPenalty}).`
                );
            } else {
                console.debug(
                    `DCC-QOL | _modifyCritRollForTargetPCLuck: No critRollFormula found to modify for target PC ${targetActor.name}.`
                );
            }
        } else {
            console.debug(
                `DCC-QOL | _modifyCritRollForTargetPCLuck: Target PC ${targetActor.name} luck mod is not a number or is zero.`
            );
        }
    }
}

/**
 * Hooks into 'dcc.rollWeaponAttack' to prepare data for the QoL Attack Card.
 * Augments the messageData object with flags needed by the renderChatMessage hook.
 *
 * @param {Roll[]} rolls - Array of roll objects involved in the attack.
 * @param {object} messageData - The chat message data object before creation.
 */
export async function prepareQoLAttackData(rolls, messageData) {
    // Extract basic data
    const actorId = messageData.system.actorId;
    const weaponId = messageData.system.weaponId;
    const tokenId = messageData.speaker.token; // Attacker's token ID

    // --- Fetch Actor and Token (prioritizing token if available) ---
    let actor;
    let attackerTokenDoc = null; // Declare in broader scope for use throughout function
    if (tokenId) {
        attackerTokenDoc = getTokenById(tokenId);
        if (attackerTokenDoc) {
            actor = attackerTokenDoc.actor;
        }
    }
    // If no actor from token, or no tokenId, fallback to actorId
    if (!actor && actorId) {
        actor = game.actors.get(actorId);
    }

    if (!actor) {
        console.warn(
            `DCC-QOL | prepareQoLAttackData: Could not determine actor. Token ID: ${tokenId}, Actor ID: ${actorId}`
        );
        // Potentially return or handle error if actor is critical and not found
        // For now, will proceed, and getWeaponFromActorById will likely warn if actor is null/undefined
    }

    const isPC = actor && actor.type === "Player";

    const tokenName = messageData.speaker.alias || messageData.speaker.name; // Attacker's display name
    const isCrit = messageData.flags["dcc.isCrit"] || false;
    const isFumble = messageData.flags["dcc.isFumble"] || false;
    const isBackstab = messageData.flags["dcc.isBackstab"] || false;
    const hitsAc = messageData.system.hitsAc; // What AC value the roll hits
    const weapon = getWeaponFromActorById(actor, weaponId);

    // Process Targets using utility function
    const targetsSet = messageData.system.targets; // This is a Set<Token>
    const targetDocument = getFirstTarget(targetsSet); // Get the TokenDocument object
    let targetActor; // Declare targetActor

    let targetName = "";
    let targetTokenId = null;
    let hitsTarget = false; // Default to false

    if (targetDocument) {
        targetName = targetDocument.name || "target"; // Get name directly
        targetTokenId = targetDocument.id; // Get ID directly
        targetActor = targetDocument.actor; // Get actor from document

        if (targetActor) {
            const targetAC = targetActor.system?.attributes?.ac?.value;
            if (targetAC !== undefined && hitsAc !== undefined) {
                hitsTarget =
                    !isFumble &&
                    (parseInt(hitsAc) >= parseInt(targetAC) ||
                        (isCrit && !isBackstab)); // Hit if not a fumble, and roll >= AC or a crit (but not a backstab crit)
                console.debug(
                    `DCC-QOL | Target AC: ${targetAC}, Hits AC: ${hitsAc}, Hits Target: ${hitsTarget}`
                );
            } else {
                console.debug(
                    `DCC-QOL | Could not determine target AC (${targetAC}) or Hits AC (${hitsAc})`
                );
            }
        }
    } else {
        console.debug(
            "DCC-QOL | No valid targets found by getFirstTarget utility."
        );
    }

    // Modify fumble die based on target PC's luck
    _modifyFumbleDieForTargetPCLuck(messageData, isFumble, targetActor);

    // Modify crit roll based on target PC's luck
    _modifyCritRollForTargetPCLuck(messageData, isCrit, targetActor);

    // --- Friendly Fire Check ---
    let showFriendlyFireButton = false;
    let friendliesInMelee = [];

    if (
        game.settings.get("dcc-qol", "automateFriendlyFire") && // if setting is enabled
        weapon &&
        !weapon.system.melee && // is Ranged weapon
        !hitsTarget &&
        targetDocument
    ) {
        // Missed a specific target with ranged weapon
        try {
            let friendlyTokenDocs = getTokensInMeleeRange(
                targetDocument,
                attackerTokenDoc?.disposition ===
                    CONST.TOKEN_DISPOSITIONS.FRIENDLY
                    ? "friendly"
                    : "enemy"
            );

            // remove the attacker token from the list of friendlies
            friendlyTokenDocs = friendlyTokenDocs.filter(
                (tokenDoc) => tokenDoc.id !== attackerTokenDoc.id
            );

            showFriendlyFireButton = friendlyTokenDocs.length > 0;

            // Store simplified token data instead of full TokenDocument objects
            // since message flags are serialized as JSON and lose object methods
            friendliesInMelee = friendlyTokenDocs.map((tokenDoc) => ({
                id: tokenDoc.id,
                name: tokenDoc.name,
                actorId: tokenDoc.actorId,
            }));
        } catch (e) {
            console.error("DCC-QOL | Error calling getTokensInMeleeRange:", e);
            showFriendlyFireButton = false; // Default to false on error
            friendliesInMelee = [];
        }
    }

    // --- Check for DCC System Automated Rolls ---
    const damageWasAutomated = !!messageData.system.damageRoll;
    const critWasAutomated = !!messageData.system.critRoll;
    const fumbleWasAutomated = !!messageData.system.fumbleRoll;

    const automatedDamageTotal = messageData.system.damageRoll?.total;
    const automatedCritTotal = messageData.system.critRoll?.total;
    const automatedFumbleTotal = messageData.system.fumbleRoll?.total;
    // critResult and fumbleResult are already enriched HTML by the DCC system if automated
    const automatedCritDetails = messageData.system.critResult || "";
    const automatedFumbleDetails = messageData.system.fumbleResult || "";
    // The DCC system uses critInlineRoll and fumbleInlineRoll for the full display string when automated
    const automatedCritDisplay = messageData.system.critInlineRoll || "";
    const automatedFumbleDisplay = messageData.system.fumbleInlineRoll || "";

    // --- Prepare QoL Data ---
    const qolData = {
        isAttackRoll: true, // Flag for the render hook
        actorId: actorId,
        weaponId: weaponId,
        tokenId: tokenId,
        tokenName: tokenName,
        isPC: isPC, // Add the isPC flag here
        target: targetName,
        targetTokenId: targetTokenId, // Ensure consistent casing
        hitsTarget: hitsTarget,
        isCrit: isCrit,
        isFumble: isFumble,
        isBackstab: isBackstab,
        deedDieResult: messageData.system?.deedDieRollResult ?? null,
        deedRollSuccess: messageData.system?.deedRollSuccess ?? null,
        hitsAc: hitsAc, // Pass the raw hitsAC value for display when no target
        showFriendlyFireButton: showFriendlyFireButton,
        friendliesInMelee: friendliesInMelee, // Store the array of friendly tokens in melee range
        options: {}, // Placeholder for future options
        // Add damage formula for display in button
        damageRollFormula: messageData.system?.damageRollFormula,
        // Add automation flags and results
        damageWasAutomated: damageWasAutomated,
        automatedDamageTotal: automatedDamageTotal,
        critWasAutomated: critWasAutomated,
        automatedCritTotal: automatedCritTotal,
        automatedCritDetails: automatedCritDetails,
        automatedCritDisplay: automatedCritDisplay, // Store the pre-rendered display string
        fumbleWasAutomated: fumbleWasAutomated,
        automatedFumbleTotal: automatedFumbleTotal,
        automatedFumbleDetails: automatedFumbleDetails,
        automatedFumbleDisplay: automatedFumbleDisplay, // Store the pre-rendered display string
    };

    // Attach QoL data to message flags
    messageData.flags.dccqol = qolData;

    console.debug(
        "DCC-QOL | Augmented messageData with flags:",
        messageData.flags.dccqol
    );
}

/**
 * Hooks into 'dcc.modifyAttackRollTerms' to apply a penalty if firing a ranged weapon
 * at a target engaged in melee with a friendly creature.
 *
 * @param {Array} terms - The array of roll terms.
 * @param {Actor} actor - The attacking actor.
 * @param {Item} weapon - The weapon item used.
 * @param {object} options - The options object from the hook, containing the actual targets Set and other roll parameters.
 */
export function applyFiringIntoMeleePenalty(terms, actor, weapon, options) {
    // Check if the setting is enabled
    if (!game.settings.get("dcc-qol", "automateFiringIntoMeleePenalty")) {
        return;
    }

    // Check if the weapon is ranged
    if (!weapon || weapon.system.melee) {
        return;
    }

    // Determine the first valid target document
    const targetDocument = getFirstTarget(options.targets);
    if (!targetDocument) {
        return;
    }

    // Get attacker token to access disposition - try options first, then fall back to actor lookup
    let attackerTokenDoc = null;

    // Try options.token first
    if (options?.token) {
        if (typeof options.token === "string") {
            attackerTokenDoc = getTokenById(options.token);
        } else if (options.token instanceof TokenDocument) {
            attackerTokenDoc = options.token;
        }
    }

    // Fall back to getting token from actor
    if (!attackerTokenDoc) {
        attackerTokenDoc = getTokenDocumentFromActor(actor);
    }

    if (!attackerTokenDoc) {
        console.debug(
            "DCC-QOL | No attacker token found for firing into melee check."
        );
        return;
    }

    try {
        const isFiringIntoMelee = checkFiringIntoMelee(
            targetDocument,
            attackerTokenDoc.disposition
        );
        if (isFiringIntoMelee) {
            console.log(
                `DCC-QOL | Firing into melee detected for target ${targetDocument.name}. Applying penalty.`
            );
            terms.push({
                type: "Modifier",
                label: game.i18n.localize(
                    "DCC-QOL.FiringIntoMeleePenaltyLabel"
                ),
                formula: "-1", // Apply a -1 penalty
            });
        } else {
        }
    } catch (e) {
        console.error("DCC-QOL | Error checking firing into melee:", e);
    }
}

/**
 * Applies range checks and penalties based on weapon type and distance to target.
 * Hooks into 'dcc.modifyAttackRollTerms'.
 *
 * @param {Array} terms - The array of roll terms.
 * @param {Actor} actor - The attacking actor.
 * @param {Item} weapon - The weapon item used.
 * @param {object} options - The options object from the hook, containing targets and other roll parameters.
 */
export function applyRangeChecksAndPenalties(terms, actor, weapon, options) {
    if (!game.settings.get("dcc-qol", "checkWeaponRange")) {
        return; // Setting disabled
    }

    let attackerTokenDoc = null;
    attackerTokenDoc = getTokenDocumentFromActor(actor);

    if (!attackerTokenDoc) {
        ui.notifications.warn(
            game.i18n.localize("DCC-QOL.WeaponRangeNoAttackerTokenWarn")
        );
        return;
    }

    // Handle targets
    const targetTokenDoc = getFirstTarget(options.targets);
    if (!targetTokenDoc) {
        console.warn(game.i18n.localize("DCC-QOL.WeaponRangeNoTargetWarn"));
        return; // No target, so no range check to perform
    }
    if (options.targets instanceof Set && options.targets.size > 1) {
        ui.notifications.warn(
            game.i18n.format("DCC-QOL.WeaponRangeMultipleTargetsWarn", {
                targetName: targetTokenDoc.name,
            })
        );
    }
    // Weapon and actor checks
    if (!weapon) {
        console.debug(
            "DCC-QOL | applyRangeChecksAndPenalties: No weapon found."
        );
        return; // No weapon, no range check
    }
    if (!actor) {
        console.debug(
            "DCC-QOL | applyRangeChecksAndPenalties: No actor found."
        );
        return; // No actor, no range check
    }

    // Ensure properties array exists for tags
    if (!options.properties) options.properties = [];

    const distance = measureTokenDistance(attackerTokenDoc, targetTokenDoc);
    const gridUnitSize = game.canvas.dimensions.distance;
    const gridUnits = game.scenes.active?.grid.units || "ft"; // Fallback to ft if units not set

    // Helper for async dialog (returns a Promise)
    // This is used to show a confirmation dialog and resolve with the user's choice
    function confirmDialog({ title, content }) {
        return new Promise((resolve) => {
            const dialog = new foundry.applications.api.DialogV2({
                window: {
                    title,
                    resizable: false,
                },
                content: `<p>${content}</p>`,
                buttons: [
                    {
                        action: "cancel",
                        label: game.i18n.localize("DCC-QOL.Cancel"),
                        default: true,
                        callback: (event, button, dialog) => {
                            resolve(false);
                            dialog.close();
                        },
                    },
                    {
                        action: "proceed",
                        label: game.i18n.localize("DCC-QOL.AttackAnyway"),
                        callback: (event, button, dialog) => {
                            resolve(true);
                            dialog.close();
                        },
                    },
                ],
                close: () => resolve(false),
            });
            dialog.render(true);
        });
    }

    // Dialog/confirmation logic
    // These variables determine if a dialog is needed, and what penalty/tag to apply
    let dialogNeeded = false;
    let dialogConfig = null;
    let tagToAdd = null;
    let penaltyType = null;

    if (weapon.system.melee) {
        // Melee Weapon Logic
        if (distance > gridUnitSize) {
            dialogNeeded = true;
            dialogConfig = {
                title: game.i18n.localize("DCC-QOL.DialogMeleeOutOfRangeTitle"),
                content: game.i18n.format(
                    "DCC-QOL.DialogMeleeOutOfRangeContent",
                    {
                        distance: Math.round(distance),
                        units: gridUnits,
                    }
                ),
            };
            tagToAdd = game.i18n.localize("DCC-QOL.TagOutOfRange");
        }
    } else {
        // Ranged Weapon Logic
        // Skip range check if the weapon has no range specified
        if (!weapon.system.range) {
            console.debug(
                `DCC-QOL | Weapon ${weapon.name} has no range specified, skipping range check.`
            );
            return;
        }

        const rangeString = weapon.system.range || "";
        const rangeParts = rangeString.split("/").map(Number);
        let shortRange = 0,
            mediumRange = 0,
            longRange = 0;
        let hasDefinedBands = false; // Flag to indicate if short/medium/long are explicitly defined

        if (rangeParts.length === 3) {
            [shortRange, mediumRange, longRange] = rangeParts;
            hasDefinedBands = true;
        } else if (rangeParts.length === 1 && !isNaN(rangeParts[0])) {
            longRange = rangeParts[0]; // Treat single number as maximum range
            // shortRange and mediumRange remain 0 (or their default), indicating no defined penalty bands for medium/long.
            // Penalties for medium/long range will only be applied if hasDefinedBands is true.
        } else {
            console.warn(
                `DCC-QOL | Weapon ${weapon.name} has an unparsable range: ${rangeString}`
            );
            return; // Cannot parse range, so skip checks
        }

        // Check if target is beyond the maximum range of the weapon (longRange)
        // This applies whether the range is defined by 3 parts or a single maximum value.
        if (distance > longRange) {
            dialogNeeded = true;
            dialogConfig = {
                title: game.i18n.localize(
                    "DCC-QOL.DialogRangedOutOfRangeTitle"
                ),
                content: game.i18n.format(
                    "DCC-QOL.DialogRangedOutOfRangeContent",
                    {
                        distance: Math.round(distance),
                        units: gridUnits,
                        weaponName: weapon.name,
                        maxRange: longRange, // Display the max range
                    }
                ),
            };
            tagToAdd = game.i18n.localize("DCC-QOL.TagOutOfRange");
            // No penaltyType is set here as the roll is typically cancelled or confirmed without penalty if out of max range.
        } else if (hasDefinedBands) {
            // Only apply medium/long range penalties if distinct range bands are defined (3-part range)
            if (distance > mediumRange) {
                // Target is at Long Range (mediumRange < distance <= longRange)
                dialogNeeded = true;
                dialogConfig = {
                    title: game.i18n.localize(
                        "DCC-QOL.DialogRangedLongRangeTitle"
                    ),
                    content: game.i18n.format(
                        "DCC-QOL.DialogRangedLongRangeContent",
                        {
                            distance: Math.round(distance),
                            units: gridUnits,
                            weaponName: weapon.name,
                            shortRange: shortRange,
                            mediumRange: mediumRange,
                            longRange: longRange,
                        }
                    ),
                };
                tagToAdd = game.i18n.localize("DCC-QOL.TagLongRange");
                penaltyType = "long";
            } else if (distance > shortRange) {
                // Target is at Medium Range (shortRange < distance <= mediumRange)
                dialogNeeded = true;
                dialogConfig = {
                    title: game.i18n.localize(
                        "DCC-QOL.DialogRangedMediumRangeTitle"
                    ),
                    content: game.i18n.format(
                        "DCC-QOL.DialogRangedMediumRangeContent",
                        {
                            distance: Math.round(distance),
                            units: gridUnits,
                            weaponName: weapon.name,
                            shortRange: shortRange,
                            mediumRange: mediumRange,
                            longRange: longRange,
                        }
                    ),
                };
                tagToAdd = game.i18n.localize("DCC-QOL.TagMediumRange");
                penaltyType = "medium";
            }
            // If distance <= shortRange (and hasDefinedBands is true), it's Short Range or closer,
            // no penalty, no warning needed for this specific band.
        }
        // If !hasDefinedBands and distance <= longRange, the target is within the weapon's single maximum range,
        // and no specific medium/long band penalties apply.
    }

    // If a dialog is needed and not yet confirmed, show the dialog and cancel the roll
    if (dialogNeeded && !options._rangeDialogConfirmed) {
        confirmDialog(dialogConfig).then(async (confirmed) => {
            if (confirmed) {
                // Re-invoke the attack roll with the confirmation flag
                const newOptions = { ...options, _rangeDialogConfirmed: true };
                // Add the tag to properties for the re-invoked roll
                if (tagToAdd) {
                    if (!newOptions.properties) newOptions.properties = [];
                    newOptions.properties.push(tagToAdd);
                }
                // Set range penalty info for the re-invoked roll
                if (penaltyType === "long" || penaltyType === "medium") {
                    newOptions._rangePenalty = penaltyType;
                }
                // Re-invoke the attack roll
                if (typeof actor.rollWeaponAttack === "function") {
                    await actor.rollWeaponAttack(weapon.id, newOptions);
                } else if (
                    actor.sheet &&
                    typeof actor.sheet._onRollWeaponAttack === "function"
                ) {
                    await actor.sheet._onRollWeaponAttack(
                        weapon.id,
                        newOptions
                    );
                } else {
                    ui.notifications.error(
                        "DCC-QOL: Unable to re-invoke attack roll after range confirmation."
                    );
                }
            }
        });
        return false;
    }

    // Apply penalties and tags if dialog was confirmed OR if no dialog was needed.
    // 'tagToAdd' and 'penaltyType' here refer to the values calculated in the current pass of this function.
    // 'options._rangePenalty' and tags already in 'options.properties' are from a previous pass if dialog was confirmed.
    if (options._rangeDialogConfirmed || !dialogNeeded) {
        let effectivePenaltyToApply = null;

        if (options._rangeDialogConfirmed) {
            // SCENARIO A: Dialog was confirmed.
            // The tag was already added to options.properties by the dialog callback.
            // Use the penalty information passed via options._rangePenalty.
            effectivePenaltyToApply = options._rangePenalty;
        } else {
            // SCENARIO B: No dialog was needed for this roll attempt.
            // Use penaltyType and tagToAdd calculated in this current execution.
            effectivePenaltyToApply = penaltyType;
            if (tagToAdd) {
                // Ensure properties array exists and add the tag if not already present
                if (!options.properties) options.properties = [];
                if (!options.properties.includes(tagToAdd)) {
                    options.properties.push(tagToAdd);
                }
            }
        }

        // Apply penalties based on the determined effectivePenaltyToApply
        if (effectivePenaltyToApply === "long") {
            if (terms.length > 0 && terms[0] && terms[0].type === "Die") {
                terms[0].formula = game.dcc.DiceChain.bumpDie(
                    terms[0].formula,
                    "-1" // DCC system uses "-1" for one step down the chain
                );
                console.debug(
                    `DCC-QOL | Applied long range penalty. Die formula: ${terms[0].formula}`
                );
            }
        } else if (effectivePenaltyToApply === "medium") {
            terms.push({
                type: "Modifier",
                label: game.i18n.localize("DCC-QOL.WeaponRangePenaltyMedium"),
                formula: "-2",
            });
            console.debug("DCC-QOL | Applied medium range penalty (-2).");
        }
    }

    // If distance <= shortRange (and hasDefinedBands is true), or if within max range for single-value ranges without defined bands,
    // it's considered within effective range, no penalty, no tag, no dialog needed for range reasons.
    console.debug(
        `DCC-QOL | Attacker: ${attackerTokenDoc.name}, Target: ${targetTokenDoc.name}, Distance: ${distance} ${gridUnits}`
    );
}
