import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import type { TModelSpec } from 'librechat-data-provider';
import type { Endpoint, SelectedValues } from '~/common';
import { EndpointItem } from '../EndpointItem';

const mockHandleSelectEndpoint = jest.fn();
const mockHandleOpenKeyDialog = jest.fn();
const mockSetEndpointSearchValue = jest.fn();

let mockSelectedValues: SelectedValues = { endpoint: '', model: '', modelSpec: '' };
let mockModelSpecs: TModelSpec[] = [];

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useFavorites: () => ({
    isFavoriteAgent: () => false,
    isFavoriteModel: () => false,
    isFavoriteSpec: () => false,
    toggleFavoriteAgent: jest.fn(),
    toggleFavoriteModel: jest.fn(),
    toggleFavoriteSpec: jest.fn(),
  }),
  useIsActiveItem: () => ({ ref: jest.fn(), isActive: false }),
}));

jest.mock('~/components/Chat/Menus/Endpoints/ModelSelectorContext', () => ({
  useModelSelectorContext: () => ({
    agentsMap: undefined,
    assistantsMap: undefined,
    modelSpecs: mockModelSpecs,
    selectedValues: mockSelectedValues,
    endpointSearchValues: {},
    endpointsConfig: {},
    handleOpenKeyDialog: mockHandleOpenKeyDialog,
    handleSelectEndpoint: mockHandleSelectEndpoint,
    handleSelectModel: jest.fn(),
    handleSelectSpec: jest.fn(),
    setEndpointSearchValue: mockSetEndpointSearchValue,
    endpointRequiresUserKey: () => false,
  }),
}));

jest.mock('~/components/Chat/Menus/Endpoints/CustomMenu', () => {
  const React = jest.requireActual<typeof import('react')>('react');

  return {
    CustomMenu: ({ children, label }: { children?: React.ReactNode; label?: React.ReactNode }) =>
      React.createElement('div', null, label, children),
    CustomMenuItem: React.forwardRef(function MockMenuItem(
      { children, ...rest }: { children?: React.ReactNode },
      ref: React.Ref<HTMLButtonElement>,
    ) {
      return React.createElement('button', { ref, type: 'button', ...rest }, children);
    }),
    CustomMenuSeparator: () => React.createElement('hr'),
  };
});

const disabledAgentsEndpoint: Endpoint = {
  value: 'agents',
  label: 'My Agents',
  hasModels: false,
  icon: null,
};

const customEndpoint: Endpoint = {
  value: 'custom',
  label: 'Custom',
  hasModels: false,
  icon: null,
};

describe('EndpointItem', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSelectedValues = { endpoint: '', model: '', modelSpec: '' };
    mockModelSpecs = [];
  });

  it('does not render agents as a leaf endpoint when no selectable rows exist', () => {
    render(<EndpointItem endpoint={disabledAgentsEndpoint} endpointIndex={0} />);

    expect(screen.queryByText('My Agents')).not.toBeInTheDocument();
    expect(mockHandleSelectEndpoint).not.toHaveBeenCalled();
  });

  it('keeps non-agent endpoints without models selectable', () => {
    render(<EndpointItem endpoint={customEndpoint} endpointIndex={0} />);

    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));

    expect(mockHandleSelectEndpoint).toHaveBeenCalledWith(customEndpoint);
  });

  it('hides raw endpoint model rows that already have a model spec', () => {
    mockModelSpecs = [
      {
        name: 'fpl-glm-4-6',
        label: 'GLM 4.6',
        group: 'bifrost-local',
        preset: { endpoint: 'bifrost-local', model: 'glm-4.6' },
      },
    ];

    render(
      <EndpointItem
        endpoint={{
          value: 'bifrost-local',
          label: 'Bifrost Local / Free',
          hasModels: true,
          icon: null,
          models: [{ name: 'glm-4.6' }, { name: 'granite-4.1-8b' }],
        }}
        endpointIndex={0}
      />,
    );

    expect(screen.getByText('GLM 4.6')).toBeInTheDocument();
    expect(screen.queryByText('glm-4.6')).not.toBeInTheDocument();
    expect(screen.getByText('granite-4.1-8b')).toBeInTheDocument();
  });
});
