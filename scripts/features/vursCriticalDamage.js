import { getDamageRollActorForVurs, VURS_CRITICAL_MAXIMUM_DIE } from "./diceless.js";
import { actorUsesVursSystem, getActorSystemMode, getSystemMode } from "./systemModes.js";

const MODULE_ID = "vurs-pf2e";
const DEFAULT_SETTING = "vursCriticalDamageInDefault";
const CRITICAL_SUCCESS = 3;
const VURS_CRITICAL_DAMAGE_PATCH = Symbol("vurs-pf2e.criticalDamagePatch");

export function installVursCriticalDamage() {
    const DamageRoll = CONFIG.Dice?.rolls?.find(rollClass => rollClass.name === "DamageRoll");
    const prototype = DamageRoll?.prototype;
    const originalEvaluate = prototype?.evaluate;
    if (typeof originalEvaluate !== "function" || prototype[VURS_CRITICAL_DAMAGE_PATCH]) return;

    const ArithmeticExpression = CONFIG.Dice.termTypes?.ArithmeticExpression;
    const Grouping = CONFIG.Dice.termTypes?.Grouping;
    const Die = foundry.dice.terms.Die;
    const NumericTerm = foundry.dice.terms.NumericTerm;
    if (!ArithmeticExpression || !Grouping) return;

    prototype.evaluate = async function (...args) {
        if (
            this.options?.degreeOfSuccess === CRITICAL_SUCCESS &&
            this.kinds?.has("damage") &&
            !this.options.vursCriticalDamageApplied &&
            usesVursCriticalDamage(this)
        ) {
            const preserveDoubleDice = this.options.critRule === "double-dice";
            const successDamageTerms = preserveDoubleDice ? getSuccessDamageTerms(this, DamageRoll) : null;
            let changed = false;
            for (const instance of this.instances ?? []) {
                instance.terms = instance.terms.map(term => {
                    const transformed = replaceCriticalDoubling(term, {
                        ArithmeticExpression,
                        Grouping,
                        Die,
                        NumericTerm,
                        preserveDoubleDice
                    });
                    if (transformed !== term) changed = true;
                    return transformed;
                });
                if (preserveDoubleDice) {
                    const addedDamageTerms = successDamageTerms?.get(`${instance.type}|${instance.persistent}`) ?? [];
                    const baseTerm = instance.terms[0];
                    if (baseTerm && addedDamageTerms.length) {
                        instance.terms = [addedDamageTerms.reduce(
                            (total, addedTerm) => createDamageSum(total, cloneMaximumDamage(addedTerm, {
                                ArithmeticExpression,
                                Grouping,
                                Die,
                                NumericTerm
                            }), { ArithmeticExpression }),
                            baseTerm
                        )];
                        changed = true;
                    }
                }
                for (const term of instance.terms) {
                    activateCriticalMaximumDice(term, { ArithmeticExpression, Grouping, Die });
                }
            }
            if (changed) this.options.vursCriticalDamageApplied = true;
        }
        return originalEvaluate.apply(this, args);
    };
    Object.defineProperty(prototype, VURS_CRITICAL_DAMAGE_PATCH, { value: true });
}

function usesVursCriticalDamage(roll) {
    const actor = getDamageRollActorForVurs(roll);
    if (actorUsesVursSystem(actor)) return true;
    const mode = actor ? getActorSystemMode(actor) : getSystemMode();
    return mode === "default" && game.settings.get(MODULE_ID, DEFAULT_SETTING) === true;
}

function getSuccessDamageTerms(criticalRoll, DamageRoll) {
    const formula = criticalRoll.options?.damage?.damage?.formula?.success;
    if (typeof formula !== "string") return null;
    try {
        const successRoll = new DamageRoll(formula);
        return successRoll.instances.reduce((damageTerms, instance) => {
            const key = `${instance.type}|${instance.persistent}`;
            damageTerms.set(key, [...(damageTerms.get(key) ?? []), ...instance.terms]);
            return damageTerms;
        }, new Map());
    } catch (error) {
        console.warn(`${MODULE_ID} | Could not determine success damage terms for a VURS critical`, error);
        return null;
    }
}

function replaceCriticalDoubling(term, classes) {
    const { ArithmeticExpression, Grouping, Die, NumericTerm, preserveDoubleDice } = classes;
    if (term instanceof ArithmeticExpression) {
        const [left, right] = term.operands;
        if (
            term.operator === "*" &&
            term.options?.crit === 2 &&
            left instanceof NumericTerm &&
            left.number === 2
        ) {
            const baseDamage = replaceCriticalDoubling(right, classes);
            const options = { ...term.options };
            delete options.crit;
            return createDamageSum(baseDamage, cloneMaximumDamage(baseDamage, classes), { ...classes, options });
        }

        const operands = term.operands.map(operand => replaceCriticalDoubling(operand, classes));
        if (operands.some((operand, index) => operand !== term.operands[index])) {
            return ArithmeticExpression.fromData({
                ...resetTermEvaluation(term.toJSON()),
                operands: operands.map(operand => resetTermEvaluation(operand.toJSON()))
            });
        }
        return term;
    }

    if (term instanceof Grouping) {
        const child = replaceCriticalDoubling(term.term, classes);
        if (child === term.term) return term;
        const data = resetTermEvaluation(term.toJSON());
        const options = { ...data.options };
        delete options.crit;
        return Grouping.fromData({
            ...data,
            options,
            term: resetTermEvaluation(child.toJSON())
        });
    }

    if (Die && term instanceof Die && /(?:^|,)\s*doubled\s*(?:,|$)/i.test(term.flavor ?? "")) {
        const normalCount = Math.floor(term.number / 2);
        if (normalCount < 1) return term;
        const dieData = term.toJSON();
        const options = { ...term.options };
        const flavors = String(options.flavor ?? "")
            .split(",")
            .map(flavor => flavor.trim())
            .filter(flavor => flavor && flavor.toLowerCase() !== "doubled");
        if (flavors.length) options.flavor = flavors.join(",");
        else delete options.flavor;
        dieData.number = normalCount;
        dieData.options = options;
        const normalDamage = Die.fromData(dieData);
        if (preserveDoubleDice) return normalDamage;
        return createDamageSum(normalDamage, cloneMaximumDamage(normalDamage, classes), classes);
    }

    return term;
}

function createDamageSum(rolledDamage, addedDamage, { ArithmeticExpression, options = {} }) {
    return ArithmeticExpression.fromData({
        class: "ArithmeticExpression",
        operator: "+",
        operands: [
            resetTermEvaluation(rolledDamage.toJSON()),
            resetTermEvaluation(addedDamage.toJSON())
        ],
        options,
        evaluated: false
    });
}

function cloneMaximumDamage(term, classes) {
    const { ArithmeticExpression, Grouping, Die } = classes;
    if (Die && term instanceof Die) {
        const data = resetTermEvaluation(term.toJSON());
        data.options = { ...data.options, vursCriticalMaximumDie: true };
        return Die.fromData(data);
    }

    if (term instanceof ArithmeticExpression) {
        const data = resetTermEvaluation(term.toJSON());
        const options = { ...data.options };
        delete options.crit;
        return ArithmeticExpression.fromData({
            ...data,
            options,
            operands: term.operands.map(operand => cloneMaximumDamage(operand, classes).toJSON())
        });
    }

    if (term instanceof Grouping) {
        const data = resetTermEvaluation(term.toJSON());
        const options = { ...data.options };
        delete options.crit;
        return Grouping.fromData({
            ...data,
            options,
            term: cloneMaximumDamage(term.term, classes).toJSON()
        });
    }

    return term.constructor.fromData(resetTermEvaluation(term.toJSON()));
}

function activateCriticalMaximumDice(term, { ArithmeticExpression, Grouping, Die }) {
    if (Die && term instanceof Die) {
        if (term.options.vursCriticalMaximumDie) {
            delete term.options.vursCriticalMaximumDie;
            term[VURS_CRITICAL_MAXIMUM_DIE] = true;
        }
        return;
    }

    if (term instanceof ArithmeticExpression) {
        for (const operand of term.operands) {
            activateCriticalMaximumDice(operand, { ArithmeticExpression, Grouping, Die });
        }
    } else if (term instanceof Grouping) {
        activateCriticalMaximumDice(term.term, { ArithmeticExpression, Grouping, Die });
    }
}

function resetTermEvaluation(termData) {
    // Rebuilt terms must not inherit cached evaluation or die results.
    const reset = { ...termData, evaluated: false };
    for (const key of ["operands", "term", "number", "faces", "die"]) {
        const value = reset[key];
        if (Array.isArray(value)) {
            reset[key] = value.map(entry =>
                entry && typeof entry === "object" && typeof entry.class === "string"
                    ? resetTermEvaluation(entry)
                    : entry
            );
        } else if (value && typeof value === "object" && typeof value.class === "string") {
            reset[key] = resetTermEvaluation(value);
        }
    }
    if (Array.isArray(reset.results)) reset.results = [];
    return reset;
}