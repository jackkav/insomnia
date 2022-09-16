import React, { FC, useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { useSelector } from 'react-redux';

import * as models from '../../../models';
import { GrpcRequest, isGrpcRequest } from '../../../models/grpc-request';
import * as requestOperations from '../../../models/helpers/request-operations';
import type { Request } from '../../../models/request';
import { selectActiveWorkspace, selectWorkspacesForActiveProject } from '../../redux/selectors';
import { DebouncedInput } from '../base/debounced-input';
import { Modal, ModalProps } from '../base/modal';
import { ModalBody } from '../base/modal-body';
import { ModalHeader } from '../base/modal-header';
import { UnconnectedCodeEditor } from '../codemirror/code-editor';
import { HelpTooltip } from '../help-tooltip';
import { MarkdownEditor } from '../markdown-editor';

export interface RequestSettingsModalOptions {
  request: Request | GrpcRequest;
  forceEditMode?: boolean;
  onHide?: () => void;
}
type Props = ModalProps & RequestSettingsModalOptions;
interface State {
  showDescription: boolean;
  defaultPreviewMode: boolean;
  activeWorkspaceIdToCopyTo: string | null;
  justCopied: boolean;
  justMoved: boolean;
}

export const RequestSettingsModal:FC<Props> = ({ request, forceEditMode, onHide }) => {
  const modalRef = useRef<Modal>(null);
  const editorRef = useRef<UnconnectedCodeEditor>(null);

  const workspacesForActiveProject = useSelector(selectWorkspacesForActiveProject);
  const workspace = useSelector(selectActiveWorkspace);

  const hasDescription = !!request.description;
  const [state, setState] = useState<State>({
    justCopied: false,
    justMoved: false,
    activeWorkspaceIdToCopyTo: null,
    showDescription: forceEditMode || hasDescription,
    defaultPreviewMode: hasDescription && !forceEditMode,
  });

  useEffect(() => {
    modalRef.current?.show();
  }, []);

  async function _handleMoveToWorkspace() {
    const { activeWorkspaceIdToCopyTo } = state;
    if (!request || !activeWorkspaceIdToCopyTo) {
      return;
    }
    const workspace = await models.workspace.getById(activeWorkspaceIdToCopyTo);
    if (!workspace) {
      return;
    }
    const patch = {
      metaSortKey: -1e9,
      // Move to top of sort order
      parentId: activeWorkspaceIdToCopyTo,
    };
    // TODO: if gRPC, we should also copy the protofile to the destination workspace - INS-267
    await requestOperations.update(request, patch);
    setState({
      ...state,
      justMoved: true,
    });
    setTimeout(() => {
      setState({
        ...state,
        justMoved: false,
      });
    }, 2000);
  }

  async function _handleCopyToWorkspace() {
    const { activeWorkspaceIdToCopyTo } = state;
    if (!request || !activeWorkspaceIdToCopyTo) {
      return;
    }
    const workspace = await models.workspace.getById(activeWorkspaceIdToCopyTo);
    if (!workspace) {
      return;
    }
    const patch = {
      metaSortKey: -1e9,
      // Move to top of sort order
      name: request.name,
      // Because duplicate will add (Copy) suffix if name is not provided in patch
      parentId: activeWorkspaceIdToCopyTo,
    };
    // TODO: if gRPC, we should also copy the protofile to the destination workspace - INS-267
    await requestOperations.duplicate(request, patch);
    setState({
      ...state,
      justCopied: true,
    });
    setTimeout(() => {
      setState({
        ...state,
        justCopied: false,
      });
    }, 2000);
    models.stats.incrementCreatedRequests();
  }
  const { showDescription, defaultPreviewMode, activeWorkspaceIdToCopyTo, justMoved, justCopied } = state;
  if (!request) {
    return null;
  }
  const toggleCheckBox = async (event:any) => {
    await requestOperations.update(request, {
      [event.currentTarget.name]: event.currentTarget.checked,
    });
  };

  return ReactDOM.createPortal(
    <Modal ref={modalRef} freshState onHide={onHide}>
      <ModalHeader>
        Request Settings{' '}
        <span className="txt-sm selectable faint monospace">{request ? request._id : ''}</span>
      </ModalHeader>
      <ModalBody className="pad">
        <div>
          <div className="form-control form-control--outlined">
            <label>
              Name{' '}
              <span className="txt-sm faint italic">(also rename by double-clicking in sidebar)</span>
              <DebouncedInput
                delay={500}
                // @ts-expect-error -- TSCONVERSION props expand into an input but are difficult to type
                type="text"
                placeholder={request.url || 'My Request'}
                defaultValue={request.name}
                onChange={async name => {
                  await requestOperations.update(request, { name });
                  // setState({
                  //   ...state,
                  //   request: updatedRequest,
                  // });
                }}
              />
            </label>
          </div>
          {isGrpcRequest(request)
            ? (
              <p className="faint italic">
                Are there any gRPC settings you expect to see? Create a{' '}
                <a href={'https://github.com/Kong/insomnia/issues/new/choose'}>feature request</a>!
              </p>
            )
            : (
              <>
                <>
                  {showDescription ? (
                    <MarkdownEditor
                      ref={editorRef}
                      className="margin-top"
                      defaultPreviewMode={defaultPreviewMode}
                      placeholder="Write a description"
                      defaultValue={request.description}
                      onChange={async (description: string) => {
                        await models.request.update(request, {
                          description,
                        });
                        setState({
                          ...state,
                          defaultPreviewMode: false,
                        });
                      }}
                    />
                  ) : (
                    <button
                      onClick={() => setState({ ...state, showDescription: true })}
                      className="btn btn--outlined btn--super-duper-compact"
                    >
                      Add Description
                    </button>
                  )}
                </>
                <>
                  <div className="pad-top pad-bottom">
                    <div className="form-control form-control--thin">
                      <label>
                        Send cookies automatically
                        <input
                          type="checkbox"
                          name="settingSendCookies"
                          checked={request['settingSendCookies']}
                          onChange={toggleCheckBox}
                        />
                      </label>
                    </div>
                    <div className="form-control form-control--thin">
                      <label>
                        Store cookies automatically
                        <input
                          type="checkbox"
                          name="settingStoreCookies"
                          checked={request['settingStoreCookies']}
                          onChange={toggleCheckBox}
                        />
                      </label>
                    </div>
                    <div className="form-control form-control--thin">
                      <label>
                        Automatically encode special characters in URL
                        <input
                          type="checkbox"
                          name="settingEncodeUrl"
                          checked={request['settingEncodeUrl']}
                          onChange={toggleCheckBox}
                        />
                        <HelpTooltip position="top" className="space-left">
                          Automatically encode special characters at send time (does not apply to query
                          parameters editor)
                        </HelpTooltip>
                      </label>
                    </div>
                    <div className="form-control form-control--thin">
                      <label>
                        Skip rendering of request body
                        <input
                          type="checkbox"
                          name="settingDisableRenderRequestBody"
                          checked={request['settingDisableRenderRequestBody']}
                          onChange={toggleCheckBox}
                        />
                        <HelpTooltip position="top" className="space-left">
                          Disable rendering of environment variables and tags for the request body
                        </HelpTooltip>
                      </label>
                    </div>
                    <div className="form-control form-control--thin">
                      <label>
                        Rebuild path dot sequences
                        <HelpTooltip position="top" className="space-left">
                          This instructs libcurl to squash sequences of "/../" or "/./" that may exist in the
                          URL's path part and that is supposed to be removed according to RFC 3986 section
                          5.2.4
                        </HelpTooltip>
                        <input
                          type="checkbox"
                          name="settingRebuildPath"
                          checked={request['settingRebuildPath']}
                          onChange={toggleCheckBox}
                        />
                      </label>
                    </div>
                  </div>
                  <div className="form-control form-control--outlined">
                    <label>
                      Follow redirects <span className="txt-sm faint italic">(overrides global setting)</span>
                      <select
                        // @ts-expect-error -- TSCONVERSION this setting only exists for a Request not GrpcRequest
                        defaultValue={state.request?.settingFollowRedirects}
                        name="settingFollowRedirects"
                        onChange={async event => {
                          await models.request.update(request, {
                            [event.currentTarget.name]: event.currentTarget.value,
                          });
                          // setState({ ...state, request: updated });
                        }}
                      >
                        <option value={'global'}>Use global setting</option>
                        <option value={'off'}>Don't follow redirects</option>
                        <option value={'on'}>Follow redirects</option>
                      </select>
                    </label>
                  </div>
                </>
                <hr />
                <div className="form-row">
                  <div className="form-control form-control--outlined">
                    <label>
                      Move/Copy to Workspace
                      <HelpTooltip position="top" className="space-left">
                        Copy or move the current request to a new workspace. It will be placed at the root of
                        the new workspace's folder structure.
                      </HelpTooltip>
                      <select
                        value={activeWorkspaceIdToCopyTo || '__NULL__'}
                        onChange={event => {
                          const { value } = event.currentTarget;
                          const workspaceId = value === '__NULL__' ? null : value;
                          setState({ ...state, activeWorkspaceIdToCopyTo: workspaceId });
                        }}
                      >
                        <option value="__NULL__">-- Select Workspace --</option>
                        {workspacesForActiveProject.map(w => {
                          if (workspace && workspace._id === w._id) {
                            return null;
                          }

                          return (
                            <option key={w._id} value={w._id}>
                              {w.name}
                            </option>
                          );
                        })}
                      </select>
                    </label>
                  </div>
                  <div className="form-control form-control--no-label width-auto">
                    <button
                      disabled={justCopied || !activeWorkspaceIdToCopyTo}
                      className="btn btn--clicky"
                      onClick={_handleCopyToWorkspace}
                    >
                      {justCopied ? 'Copied!' : 'Copy'}
                    </button>
                  </div>
                  <div className="form-control form-control--no-label width-auto">
                    <button
                      disabled={justMoved || !activeWorkspaceIdToCopyTo}
                      className="btn btn--clicky"
                      onClick={_handleMoveToWorkspace}
                    >
                      {justMoved ? 'Moved!' : 'Move'}
                    </button>
                  </div>
                </div>
              </>)
          }
        </div>
      </ModalBody>
    </Modal>,
    document.querySelector('#modal-portal'));
};

RequestSettingsModal.displayName = 'RequestSettingsModal';
