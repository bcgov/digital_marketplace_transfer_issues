import * as FormField from 'front-end/lib/components/form-field';
import * as DateField from 'front-end/lib/components/form-field/date';
import * as NumberField from 'front-end/lib/components/form-field/number';
import { ComponentViewProps, Dispatch, immutable, Immutable, Init, mapComponentDispatch, Update, updateComponentChild, View } from 'front-end/lib/framework';
import { ThemeColor } from 'front-end/lib/types';
import Accordion from 'front-end/lib/views/accordion';
import Icon, { AvailableIcons } from 'front-end/lib/views/icon';
import Link, { iconLinkSymbol, leftPlacement } from 'front-end/lib/views/link';
import { find } from 'lodash';
import React from 'react';
import { Col, Row } from 'reactstrap';
import CAPABILITIES from 'shared/lib/data/capabilities';
import { CreateSWUOpportunityPhaseBody, CreateSWUOpportunityPhaseRequiredCapabilityBody, CreateSWUOpportunityPhaseValidationErrors, SWUOpportunityPhase } from 'shared/lib/resources/opportunity/sprint-with-us';
import { adt, ADT } from 'shared/lib/types';
import { invalid, Validation } from 'shared/lib/validation';
import * as opportunityValidation from 'shared/lib/validation/opportunity/sprint-with-us';

export interface Capability extends CreateSWUOpportunityPhaseRequiredCapabilityBody {
  checked: boolean;
}

export interface Params {
  phase?: SWUOpportunityPhase;
  totalMaxBudget?: number;
  isAccordianOpen: boolean;
  validateStartDate(raw: string): Validation<Date>;
  validateCompletionDate(raw: string, startDate?: Date): Validation<Date>;
}

export interface State extends Pick<Params, 'isAccordianOpen' | 'validateCompletionDate'> {
  startDate: Immutable<DateField.State>;
  completionDate: Immutable<DateField.State>;
  maxBudget: Immutable<NumberField.State>;
  capabilities: Capability[];
}

export type Msg
  = ADT<'toggleAccordion'>
  | ADT<'toggleCapabilityChecked', number> //index
  | ADT<'toggleCapabilityIsFullTime', number> //index
  | ADT<'startDate', DateField.Msg>
  | ADT<'completionDate', DateField.Msg>
  | ADT<'maxBudget', NumberField.Msg>;

export function setValidateStartDate(state: Immutable<State>, validate: Params['validateStartDate']): Immutable<State> {
  return state.update('startDate', s => FormField.setValidate(s, DateField.validateDate(validate), !!FormField.getValue(s)));
}

function resetCompletionDate(state: Immutable<State>): Immutable<State> {
  return state.update('completionDate', s => FormField.setValidate(
    s,
    DateField.validateDate(raw => state.validateCompletionDate(raw, DateField.getDate(state.startDate))),
    !!FormField.getValue(s)
  ));
}

export function updateTotalMaxBudget(state: Immutable<State>, totalMaxBudget?: number): Immutable<State> {
  return state.update('maxBudget', s => FormField.setValidate(
    s,
    v => {
      if (v === null) { return invalid(['Please enter a valid Maximum Phase Budget.']); }
      return opportunityValidation.validateSWUOpportunityPhaseMaxBudget(v, totalMaxBudget);
    },
    FormField.getValue(s) !== null
  ));
}

export function setIsAccordianOpen(state: Immutable<State>, isAccordianOpen: boolean): Immutable<State> {
  return state.set('isAccordianOpen', isAccordianOpen);
}

export const init: Init<Params, State> = async ({ isAccordianOpen, totalMaxBudget, phase, validateStartDate, validateCompletionDate }) => {
  const idNamespace = String(Math.random());
  const existingCapabilities = phase?.requiredCapabilities || [];
  return {
    isAccordianOpen,
    validateCompletionDate,
    capabilities: CAPABILITIES.map(capability => {
      const found = find(existingCapabilities, { capability });
      return {
        capability,
        fullTime: found?.fullTime || true,
        checked: !!found
      };
    }),
    startDate: immutable(await DateField.init({
      errors: [],
      validate: DateField.validateDate(validateStartDate),
      child: {
        value: phase?.startDate ? DateField.dateToValue(phase.startDate) : null,
        id: `swu-opportunity-phase-${idNamespace}-start-date`
      }
    })),
    completionDate: immutable(await DateField.init({
      errors: [],
      validate: DateField.validateDate(raw => validateCompletionDate(raw, phase?.startDate)),
      child: {
        value: phase?.completionDate ? DateField.dateToValue(phase.completionDate) : null,
        id: `swu-opportunity-phase-${idNamespace}-completion-date`
      }
    })),
    maxBudget: immutable(await NumberField.init({
      errors: [],
      validate: v => {
        if (v === null) { return invalid(['Please enter a valid Maximum Phase Budget.']); }
        return opportunityValidation.validateSWUOpportunityPhaseMaxBudget(v, totalMaxBudget);
      },
      child: {
        value: phase ? phase.maxBudget : null,
        id: `swu-opportunity-phase-${idNamespace}-max-budget`,
        min: 1
      }
    }))
  };
};

export const update: Update<State, Msg> = ({ state, msg }) => {
  switch (msg.tag) {
    case 'toggleAccordion':
      return [state.update('isAccordianOpen', v => !v)];

    case 'toggleCapabilityChecked':
      return [state.update('capabilities', cs => cs.map((c, i) => {
        return i === msg.value ? { ...c, checked: !c.checked } : c;
      }))];

    case 'toggleCapabilityIsFullTime':
      return [state.update('capabilities', cs => cs.map((c, i) => {
        return i === msg.value ? { ...c, fullTime: !c.fullTime } : c;
      }))];

    case 'startDate':
      return updateComponentChild({
        state,
        childStatePath: ['startDate'],
        childUpdate: DateField.update,
        childMsg: msg.value,
        mapChildMsg: value => adt('startDate', value),
        updateAfter: state => [resetCompletionDate(state)]
      });

    case 'completionDate':
      return updateComponentChild({
        state,
        childStatePath: ['completionDate'],
        childUpdate: DateField.update,
        childMsg: msg.value,
        mapChildMsg: value => adt('completionDate', value)
      });

    case 'maxBudget':
      return updateComponentChild({
        state,
        childStatePath: ['maxBudget'],
        childUpdate: NumberField.update,
        childMsg: msg.value,
        mapChildMsg: value => adt('maxBudget', value)
      });
  }
};

export type Values = CreateSWUOpportunityPhaseBody;

export function getValues(state: Immutable<State>): Values | null {
  const maxBudget = FormField.getValue(state.maxBudget);
  if (maxBudget === null) { return null; }
  return {
    startDate: DateField.getValueAsString(state.startDate),
    completionDate: DateField.getValueAsString(state.completionDate),
    maxBudget,
    requiredCapabilities: state.capabilities.map(({ capability, fullTime }) => ({ capability, fullTime }))
  };
}

export type Errors = CreateSWUOpportunityPhaseValidationErrors;

export function setErrors(state: Immutable<State>, errors?: Errors): Immutable<State> {
  return state
    .update('startDate', s => FormField.setErrors(s, errors?.startDate || []))
    .update('completionDate', s => FormField.setErrors(s, errors?.completionDate || []))
    .update('maxBudget', s => FormField.setErrors(s, errors?.maxBudget || []));
}

function capabilitiesAreValid(capabilities: Capability[]): boolean {
  for (const c of capabilities) {
    if (c.checked) { return true; }
  }
  return false;
}

export function isValid(state: Immutable<State>): boolean {
  return FormField.isValid(state.startDate)
      && FormField.isValid(state.completionDate)
      && FormField.isValid(state.maxBudget)
      && capabilitiesAreValid(state.capabilities);
}

export interface Props extends ComponentViewProps<State, Msg> {
  title: string;
  description: string;
  icon: AvailableIcons;
  iconColor?: ThemeColor;
  deliverables: string[];
  disabled?: boolean;
  className?: string;
}

const Description: View<Props> = ({ description, deliverables }) => {
  return (
    <Row className='mb-4'>
      <Col xs='12'>
        <p>{description}</p>
        <div className='d-flex align-items-center flex-nowrap mb-3'>
          <Icon name='cubes' color='body' />
          <div className='ml-2 font-weight-bold'>Common Deliverables</div>
        </div>
        <ul>
          {deliverables.map((deliverable, i) => (<li key={`phase-deliverable-${i}`}>{deliverable}</li>))}
        </ul>
      </Col>
    </Row>
  );
};

const Details: View<Props> = ({ state, dispatch, disabled }) => {
  return (
    <Row className='mb-4'>
      <Col xs='12'>
        <h4 className='mb-4'>Details</h4>
      </Col>
      <Col xs='12' md='6'>
        <DateField.view
          required
          extraChildProps={{}}
          label='Phase Start Date'
          state={state.startDate}
          disabled={disabled}
          dispatch={mapComponentDispatch(dispatch, value => adt('startDate' as const, value))} />
      </Col>
      <Col xs='12' md='6'>
        <DateField.view
          extraChildProps={{}}
          label='Phase Completion Date'
          state={state.completionDate}
          disabled={disabled}
          dispatch={mapComponentDispatch(dispatch, value => adt('completionDate' as const, value))} />
      </Col>
      <Col xs='12' md='7' lg='6'>
        <NumberField.view
          required
          extraChildProps={{ prefix: '$' }}
          placeholder='Maximum Phase Budget'
          label='Maximum Phase Budget'
          state={state.maxBudget}
          disabled={disabled}
          dispatch={mapComponentDispatch(dispatch, value => adt('maxBudget' as const, value))} />
      </Col>
    </Row>
  );
};

interface FullTimeSwitchProps {
  fullTime: boolean;
  disabled?: boolean;
  index: number;
  dispatch: Dispatch<Msg>;
}

const FullTimeSwitch: View<FullTimeSwitchProps> = ({ fullTime, disabled, index, dispatch }) => {
  const selectedClassName = (selected: boolean) => {
    return selected ? 'bg-purple text-white' : 'text-secondary border';
  };
  const baseSwitchClassName = 'd-flex justify-content-center align-items-center';
  const width = '2rem';
  const padding = '0.15rem 0.25rem';
  return (
    <div
      onClick={() => dispatch(adt('toggleCapabilityIsFullTime', index))}
      style={{ cursor: 'pointer' }}
      className='d-flex align-items-stretch font-size-extra-small font-weight-bold ml-auto'>
      <div className={`${baseSwitchClassName} ${selectedClassName(!fullTime)} rounded-left border-right-0`} style={{ width, padding }}>
        P/T
      </div>
      <div className={`${baseSwitchClassName} ${selectedClassName(fullTime)} rounded-right border-left-0`} style={{ width, padding }}>
        F/T
      </div>
    </div>
  );
};

interface CapabilityProps extends Capability {
  index: number;
  disabled?: boolean;
  dispatch: Dispatch<Msg>;
}

const Capability: View<CapabilityProps> = ({ capability, fullTime, checked, dispatch, index, disabled }) => {
  return (
    <div className='border-right border-bottom d-flex flex-nowrap align-items-center p-2'>
      <Link
        onClick={() => dispatch(adt('toggleCapabilityChecked', index))}
        symbol_={leftPlacement(iconLinkSymbol(checked ? 'check-circle' : 'circle'))}
        symbolClassName={checked ? 'text-success' : 'text-body'}
        className='py-1 font-size-small text-nowrap'
        iconSymbolSize={0.9}
        color='body'
        disabled={disabled}>
        {capability}
      </Link>
      {checked ? (<FullTimeSwitch fullTime={fullTime} disabled={disabled} index={index} dispatch={dispatch} />) : null}
    </div>
  );
};

const Capabilities: View<Props> = ({ state, dispatch, disabled }) => {
  return (
    <Row>
      <Col xs='12'>
        <h4>Team Capabilities</h4>
        <p className='mb-4'>Select the capabilities that you will need during this phase and
          indicate whether you expect the need to be for part-time or
          full-time.</p>
      </Col>
      <Col xs='12'>
        <Row noGutters className='border-top border-left'>
          {state.capabilities.map((c, i) => (
            <Col xs='12' md='6' key={`phase-capability-${i}`}>
              <Capability
                {...c}
                dispatch={dispatch}
                disabled={disabled}
                index={i} />
            </Col>
          ))}
        </Row>
      </Col>
    </Row>
  );
};

export const view: View<Props> = props => {
  const { state, title, icon, iconColor, dispatch, className } = props;
  return (
    <Accordion
      className={className}
      toggle={() => dispatch(adt('toggleAccordion'))}
      color='blue-dark'
      title={title}
      titleClassName='h3 mb-0'
      icon={icon}
      iconWidth={2}
      iconHeight={2}
      iconClassName='mr-3'
      iconColor={iconColor}
      chevronWidth={1.5}
      chevronHeight={1.5}
      open={state.isAccordianOpen}>
      <Description {...props} />
      <Details {...props} />
      <Capabilities {...props} />
    </Accordion>
  );
};